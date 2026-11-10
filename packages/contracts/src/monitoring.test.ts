// T-630 REQ-INT-012 (ADR-073) — every monitoring adapter's payload normalised into one monitoring event. The
// Alertmanager payload below follows Alertmanager's webhook_config documentation; the recorded one (captured from a
// real Alertmanager in T-634) is read in the last case. The Zabbix, Nagios, Datadog, SolarWinds and Splunk payloads are
// written from those tools' documented macros and variables in the shapes ADR-073 configures; none is a recording.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  hostOf,
  hostTargets,
  monitoringEffect,
  monitoringSettingsOf,
  monitoringSourceKeys,
  MonitoringPayloadError,
  parseMonitoringPayload,
  severityFromWord,
  type ParseContext,
} from './monitoring.js';

const ctx: ParseContext = { receivedAt: '2026-11-10T12:00:00.000Z', defaultSeverity: 'medium' };
const CI = '0b6f2a3e-5d1c-4c8e-9a7b-2f4e6d8c0a1b';

describe('monitoring targets and severity', () => {
  it('reads host parts of instance labels, URLs and bracketed IPv6', () => {
    expect(hostOf('web-01.lab.test:9100')).toBe('web-01.lab.test');
    expect(hostOf('10.20.0.5:9100')).toBe('10.20.0.5');
    expect(hostOf('[fd00::5]:9100')).toBe('fd00::5');
    expect(hostOf('fd00::5')).toBe('fd00::5');
    expect(hostOf('https://db-01.lab.test:8443/health')).toBe('db-01.lab.test');
    expect(hostTargets('WEB-01.Lab.Test.')).toEqual([
      { kind: 'fqdn', value: 'web-01.lab.test' },
      { kind: 'hostname', value: 'web-01' },
    ]);
    expect(hostTargets('10.20.0.5:9100', 'instance')).toEqual([{ kind: 'ip', value: '10.20.0.5' }]);
    expect(hostTargets('not-a-uuid', 'ci_id')).toEqual([]);
    expect(monitoringSourceKeys([{ kind: 'ci_id', value: CI }, { kind: 'fqdn', value: 'A.b' }, { kind: 'hostname', value: 'a' }])).toEqual(['a.b', 'a']);
  });

  it('maps severity words and caps the health effect', () => {
    expect(severityFromWord('Critical')).toBe('critical');
    expect(severityFromWord('P2')).toBe('high');
    expect(severityFromWord('warning')).toBe('medium');
    expect(severityFromWord('banana')).toBeNull();
    expect(monitoringEffect('critical')).toBe('down');
    expect(monitoringEffect('low')).toBe('degraded');
    expect(monitoringEffect('informational')).toBeNull();
    expect(monitoringEffect('critical', 'degraded')).toBe('degraded');
    expect(monitoringEffect('critical', 'none')).toBeNull();
    expect(monitoringSettingsOf({ urlToken: true, maxEffect: 'bogus' })).toEqual({ urlToken: false, maxEffect: 'down' });
    expect(monitoringSettingsOf({ urlToken: true, resolveAfterMinutes: 15 })).toEqual({ urlToken: true, maxEffect: 'down', resolveAfterMinutes: 15 });
  });
});

describe('Alertmanager webhook v4', () => {
  const body = {
    version: '4',
    groupKey: '{}:{alertname="NodeDown"}',
    truncatedAlerts: 0,
    status: 'firing',
    receiver: 'openmap',
    groupLabels: { alertname: 'NodeDown' },
    commonLabels: { alertname: 'NodeDown', job: 'node' },
    commonAnnotations: {},
    externalURL: 'http://alertmanager.lab.test:9093',
    alerts: [
      {
        status: 'firing',
        labels: { alertname: 'NodeDown', instance: 'web-01.lab.test:9100', job: 'node', severity: 'critical' },
        annotations: { summary: 'Node exporter unreachable', description: 'web-01 has not answered for 5m' },
        startsAt: '2026-11-10T11:55:00.000Z',
        endsAt: '0001-01-01T00:00:00Z',
        generatorURL: 'http://prometheus.lab.test:9090/graph',
        fingerprint: 'a1b2c3d4e5f60718',
      },
      {
        status: 'resolved',
        labels: { alertname: 'DiskFull', hostname: 'db-01', openmap_ci_id: CI, severity: 'warning' },
        annotations: {},
        startsAt: '2026-11-10T10:00:00.000Z',
        endsAt: '2026-11-10T11:59:00.000Z',
      },
    ],
  };

  it('normalises each alert of the group', () => {
    const { events, ignored } = parseMonitoringPayload('prometheus_alertmanager', body, ctx);
    expect(ignored).toBe(0);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      vendor: 'prometheus_alertmanager',
      fingerprint: 'a1b2c3d4e5f60718',
      status: 'firing',
      severity: 'critical',
      title: 'NodeDown: Node exporter unreachable',
      description: 'web-01 has not answered for 5m',
      startsAt: '2026-11-10T11:55:00.000Z',
      endsAt: null,
      targets: [
        { kind: 'instance', value: 'web-01.lab.test' },
        { kind: 'hostname', value: 'web-01' },
      ],
      labels: { alertname: 'NodeDown', job: 'node', instance: 'web-01.lab.test:9100', severity: 'critical' },
      sourceUrl: 'http://prometheus.lab.test:9090/graph',
    });
    const resolved = events[1];
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.severity).toBe('medium');
    expect(resolved?.endsAt).toBe('2026-11-10T11:59:00.000Z');
    expect(resolved?.targets[0]).toEqual({ kind: 'ci_id', value: CI });
    expect(resolved?.fingerprint).toMatch(/^[0-9a-f]{16}$/u);
    // A fingerprint derived from labels is stable.
    expect(parseMonitoringPayload('prometheus_alertmanager', body, ctx).events[1]?.fingerprint).toBe(resolved?.fingerprint);
  });

  it('refuses another payload version and a body that is not Alertmanager’s', () => {
    expect(() => parseMonitoringPayload('prometheus_alertmanager', { ...body, version: '3' }, ctx)).toThrow(MonitoringPayloadError);
    expect(() => parseMonitoringPayload('prometheus_alertmanager', { hello: 'world' }, ctx)).toThrow(MonitoringPayloadError);
  });

  it('reads the payload recorded from a real Alertmanager (T-634)', () => {
    const recorded: unknown = JSON.parse(readFileSync(new URL('../../testing/fixtures/monitoring/alertmanager-webhook-v4.json', import.meta.url), 'utf8'));
    const { events } = parseMonitoringPayload('prometheus_alertmanager', recorded, ctx);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.fingerprint).not.toBe('');
      expect(e.targets.length).toBeGreaterThan(0);
    }
  });
});

describe('Zabbix webhook media type', () => {
  const problem = {
    event_source: '0',
    event_value: '1',
    event_update_status: '0',
    event_id: '73021',
    event_name: 'Zabbix agent is not available',
    event_nseverity: '4',
    event_severity: 'High',
    event_date: '2026.11.10',
    event_time: '11:58:02',
    event_tags: 'service:payments,openmap_ci_id:' + CI,
    host_host: 'app-01.lab.test',
    host_name: 'App server 01',
    host_ip: '10.20.0.11',
    trigger_id: '20011',
    zabbix_url: 'https://zabbix.lab.test/',
    alert_message: 'No data from agent for 3m',
  };

  it('reads a problem with its severity level, tags and a link to the event', () => {
    const [e] = parseMonitoringPayload('zabbix', problem, ctx).events;
    expect(e).toMatchObject({
      vendor: 'zabbix',
      fingerprint: '73021',
      status: 'firing',
      severity: 'high',
      title: 'Zabbix agent is not available',
      description: 'No data from agent for 3m',
      startsAt: '2026-11-10T11:58:02.000Z',
      endsAt: null,
      sourceUrl: 'https://zabbix.lab.test/tr_events.php?triggerid=20011&eventid=73021',
    });
    expect(e?.targets.map((t) => t.kind + ':' + t.value)).toEqual([
      'ci_id:' + CI,
      'fqdn:app-01.lab.test',
      'ip:10.20.0.11',
      'hostname:app-01',
      'hostname:app server 01',
    ]);
    expect(e?.labels['service']).toBe('payments');
  });

  it('resolves on recovery and ignores events that are not trigger events', () => {
    const [r] = parseMonitoringPayload('zabbix', { ...problem, event_value: '0', event_recovery_date: '2026.11.10', event_recovery_time: '12:03:00' }, ctx).events;
    expect(r?.status).toBe('resolved');
    expect(r?.fingerprint).toBe('73021');
    expect(r?.endsAt).toBe('2026-11-10T12:03:00.000Z');
    expect(parseMonitoringPayload('zabbix', { ...problem, event_source: '1' }, ctx)).toEqual({ events: [], ignored: 1 });
    expect(() => parseMonitoringPayload('zabbix', { event_value: '1' }, ctx)).toThrow(MonitoringPayloadError);
  });
});

describe('Nagios / Icinga notification command', () => {
  it('reads host and service problems and their recovery', () => {
    const host = parseMonitoringPayload('nagios', { notification_type: 'PROBLEM', host_name: 'core-sw-01', host_address: '10.0.0.2', host_state: 'DOWN', output: 'PING CRITICAL - Packet loss = 100%', timestamp: '1794312000' }, ctx).events[0];
    expect(host).toMatchObject({ status: 'firing', severity: 'critical', fingerprint: 'host:core-sw-01', title: 'core-sw-01 DOWN', startsAt: '2026-11-10T12:00:00.000Z' });
    expect(host?.targets).toEqual([
      { kind: 'ip', value: '10.0.0.2' },
      { kind: 'hostname', value: 'core-sw-01' },
    ]);
    const service = parseMonitoringPayload('nagios', { notification_type: 'PROBLEM', host_name: 'db-01', service_description: 'Disk /var', service_state: 'WARNING' }, ctx).events[0];
    expect(service).toMatchObject({ severity: 'medium', fingerprint: 'service:db-01:Disk /var', status: 'firing' });
    const recovery = parseMonitoringPayload('nagios', { notification_type: 'RECOVERY', host_name: 'db-01', service_description: 'Disk /var', service_state: 'OK' }, ctx).events[0];
    expect(recovery).toMatchObject({ status: 'resolved', fingerprint: 'service:db-01:Disk /var' });
    expect(parseMonitoringPayload('nagios', { notification_type: 'DOWNTIMESTART', host_name: 'db-01' }, ctx)).toEqual({ events: [], ignored: 1 });
    expect(() => parseMonitoringPayload('nagios', { notification_type: 'PROBLEM' }, ctx)).toThrow(MonitoringPayloadError);
  });
});

describe('Datadog webhook', () => {
  it('reads priority, the host tag and recovery within one alert cycle', () => {
    const triggered = {
      id: '7071938202356787111',
      alert_id: '123456',
      alert_cycle_key: '7071938202356787000',
      title: '[Triggered] CPU high on web-02',
      body: 'CPU above 95% for 10m',
      alert_transition: 'Triggered',
      alert_type: 'error',
      priority: 'P1',
      hostname: '',
      tags: 'env:prod,host:web-02.lab.test,openmap_ci_id:' + CI,
      date: '1794312000000',
      link: 'https://app.datadoghq.eu/event/event?id=7071938202356787111',
    };
    const [e] = parseMonitoringPayload('datadog', triggered, ctx).events;
    expect(e).toMatchObject({ status: 'firing', severity: 'critical', fingerprint: '7071938202356787000', startsAt: '2026-11-10T12:00:00.000Z' });
    expect(e?.targets.map((t) => t.kind)).toEqual(['ci_id', 'fqdn', 'hostname']);
    const [r] = parseMonitoringPayload('datadog', { ...triggered, alert_transition: 'Recovered', priority: '' , alert_type: 'success' }, ctx).events;
    expect(r).toMatchObject({ status: 'resolved', fingerprint: '7071938202356787000' });
    const [w] = parseMonitoringPayload('datadog', { ...triggered, alert_transition: 'Warn', priority: '' }, ctx).events;
    expect(w?.severity).toBe('medium');
  });
});

describe('SolarWinds Orion alert action', () => {
  it('reads trigger and reset of one alert object', () => {
    const trigger = {
      alert_name: 'Node is down',
      alert_object_id: '5512',
      alert_active_id: '80211',
      severity: 'Critical',
      action: 'trigger',
      node_name: 'edge-rtr-02',
      ip_address: '10.9.0.1',
      dns: 'edge-rtr-02.lab.test',
      message: 'Node edge-rtr-02 is Down.',
      details_url: 'https://orion.lab.test/Orion/View.aspx?NetObject=AAT:5512',
      triggered_at: '2026-11-10T11:50:00Z',
    };
    const [e] = parseMonitoringPayload('solarwinds', trigger, ctx).events;
    expect(e).toMatchObject({ status: 'firing', severity: 'critical', fingerprint: '5512', title: 'Node is down: edge-rtr-02' });
    expect(e?.targets.map((t) => t.value)).toEqual(['edge-rtr-02.lab.test', '10.9.0.1', 'edge-rtr-02']);
    expect(parseMonitoringPayload('solarwinds', { ...trigger, action: 'reset', severity: 'Serious' }, ctx).events[0]).toMatchObject({ status: 'resolved', severity: 'high' });
  });
});

describe('Splunk webhook alert action', () => {
  it('reads the first result row and fingerprints the search with its host', () => {
    const body = {
      result: { host: 'pay-api-01', severity: 'high', count: '42', _time: '1794312000' },
      sid: 'scheduler__admin__search__RMD5_at_1794312000_1',
      results_link: 'https://splunk.lab.test:8000/app/search/@go?sid=scheduler__admin',
      search_name: 'Payment API 5xx spike',
      owner: 'admin',
      app: 'search',
    };
    const [e] = parseMonitoringPayload('splunk', body, ctx).events;
    expect(e).toMatchObject({ status: 'firing', severity: 'high', title: 'Payment API 5xx spike', startsAt: '2026-11-10T12:00:00.000Z' });
    expect(e?.targets).toEqual([{ kind: 'hostname', value: 'pay-api-01' }]);
    expect(e?.labels['count']).toBe('42');
    expect(parseMonitoringPayload('splunk', body, ctx).events[0]?.fingerprint).toBe(e?.fingerprint);
    expect(() => parseMonitoringPayload('splunk', { result: {} }, ctx)).toThrow(MonitoringPayloadError);
  });
});
