// T-562 REQ-INT-009 (ADR-065) — notification severity, facts, console paths, settings and each sink's payload: Slack
// Block Kit, a Teams Adaptive Card, a PagerDuty Events v2 trigger and an email in both directions of text.
import { describe, expect, it } from 'vitest';
import {
  emailMessage,
  isNotificationVendor,
  notificationFacts,
  notificationPath,
  notificationSettingsSchema,
  notificationSeverity,
  pagerDutyPayload,
  severityAtLeast,
  slackPayload,
  teamsPayload,
  type RenderedNotification,
} from './notification.js';

const rendered: RenderedNotification = {
  title: 'SLA breached: Card payments',
  severity: 'critical',
  severityLabel: 'Critical',
  facts: [
    ['service', 'Card payments'],
    ['availability', '99.2'],
  ],
  url: 'https://openmap.example/en/services',
  openLabel: 'Open in OpenMap',
  footer: 'OpenMap · 2026-11-10 12:00',
};

describe('notification events', () => {
  it('reads severity from the event, else from its type', () => {
    expect(notificationSeverity({ type: 'openmap.incident.opened', data: { severity: 'high' } })).toBe(
      'critical',
    );
    expect(notificationSeverity({ type: 'openmap.bsm.health.changed', data: { state: 'degraded' } })).toBe(
      'warning',
    );
    expect(notificationSeverity({ type: 'openmap.bsm.health.changed', data: { state: 'healthy' } })).toBe(
      'info',
    );
    expect(notificationSeverity({ type: 'openmap.bsm.sla.breached', data: {} })).toBe('critical');
    expect(
      notificationSeverity({
        type: 'openmap.certificate.expiring',
        data: { thresholdDays: 30, expired: false },
      }),
    ).toBe('warning');
    expect(
      notificationSeverity({
        type: 'openmap.certificate.expiring',
        data: { thresholdDays: 0, expired: true },
      }),
    ).toBe('critical');
    expect(notificationSeverity({ type: 'openmap.ci.updated', data: {} })).toBe('info');
    expect(severityAtLeast('warning', 'info')).toBe(true);
    expect(severityAtLeast('info', 'warning')).toBe(false);
  });

  it('keeps scalar facts, caps their number and length, and links each event to its screen', () => {
    const long = 'x'.repeat(500);
    const facts = notificationFacts({
      name: 'web-01',
      count: 3,
      ok: true,
      tags: ['a', 'b'],
      nested: { a: 1 },
      empty: '',
      note: long,
    });
    expect(facts.slice(0, 4)).toEqual([
      ['name', 'web-01'],
      ['count', '3'],
      ['ok', 'true'],
      ['tags', 'a, b'],
    ]);
    expect(facts[4]?.[1].length).toBe(200);
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => ['k' + String(i), i]));
    expect(notificationFacts(many)).toHaveLength(10);
    expect(notificationPath({ type: 'openmap.ci.updated', subject: 'a b' })).toBe('/cmdb/a%20b');
    expect(notificationPath({ type: 'openmap.bsm.sla.breached', subject: 'x' })).toBe('/services');
    expect(notificationPath({ type: 'openmap.integration.notification.test', subject: 'x' })).toBe(
      '/integrations',
    );
    expect(notificationPath({ type: 'openmap.audit.action', subject: 'x' })).toBe('/dashboard');
  });

  it('takes notification settings with defaults and refuses bad addresses', () => {
    expect(notificationSettingsSchema.parse({ remoteIdPath: 'x' })).toEqual({
      minSeverity: 'info',
      to: [],
      startTls: true,
    });
    expect(notificationSettingsSchema.safeParse({ to: ['not-an-address'] }).success).toBe(false);
    expect(isNotificationVendor('slack')).toBe(true);
    expect(isNotificationVendor('servicenow')).toBe(false);
  });
});

describe('notification payloads', () => {
  it('builds a Slack Block Kit message with a fallback text, fields and a link button', () => {
    const p = slackPayload(rendered) as { text: string; blocks: Array<Record<string, unknown>> };
    expect(p.text).toBe('Critical: SLA breached: Card payments');
    expect(p.blocks.map((b) => b['type'])).toEqual(['header', 'context', 'section', 'actions']);
    expect(p.blocks[2]).toEqual({
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*service*\nCard payments' },
        { type: 'mrkdwn', text: '*availability*\n99.2' },
      ],
    });
    expect(JSON.stringify(p.blocks[3])).toContain('https://openmap.example/en/services');
  });

  it('builds a Teams Adaptive Card coloured by severity with facts and an open action', () => {
    const p = teamsPayload(rendered) as {
      type: string;
      attachments: Array<{ contentType: string; content: Record<string, unknown> }>;
    };
    expect(p.type).toBe('message');
    const card = p.attachments[0];
    expect(card?.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(card?.content).toMatchObject({
      type: 'AdaptiveCard',
      version: '1.4',
      actions: [{ type: 'Action.OpenUrl', url: rendered.url }],
    });
    expect((card?.content['body'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      text: rendered.title,
      color: 'Attention',
    });
  });

  it('builds a PagerDuty trigger deduplicated per subject and event type', () => {
    const p = pagerDutyPayload(
      rendered,
      { type: 'openmap.bsm.sla.breached', subject: 'svc-1', time: '2026-11-10T12:00:00.000Z' },
      'R0UTING',
    );
    expect(p).toMatchObject({
      routing_key: 'R0UTING',
      event_action: 'trigger',
      dedup_key: 'openmap.bsm.sla.breached:svc-1',
      payload: {
        summary: rendered.title,
        severity: 'critical',
        source: 'openmap',
        custom_details: { service: 'Card payments' },
      },
    });
  });

  it('writes an email with an escaped HTML body that reads right to left in Arabic', () => {
    const m = emailMessage({ ...rendered, facts: [['note', '<b>&</b>']] }, 'rtl');
    expect(m.subject).toBe('[Critical] SLA breached: Card payments');
    expect(m.text).toContain('note: <b>&</b>');
    expect(m.html).toContain('<html dir="rtl">');
    expect(m.html).toContain('&lt;b&gt;&amp;&lt;/b&gt;');
  });
});
