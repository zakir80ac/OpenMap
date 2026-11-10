// T-633 T-634 REQ-INT-012 (ADR-073) — monitoring event ingest against the compose stack (Postgres, Memgraph, OpenBao),
// in a tenant of its own, with the API in process and the BSM engine's monitoring overlay and recompute in process:
// - T-633: each vendor's payload is accepted at its integration's endpoint with that integration's OpenBao credential
//   (Alertmanager and Zabbix with a bearer token, Nagios with an HMAC signature, Datadog with a bearer token, SolarWinds
//   with basic credentials, Splunk with a URL token), resolved to CIs by FQDN, identity token, CI id tag and name, or
//   left unresolved and listed; a mapping resolves it; unknown integrations, wrong credentials and foreign payloads are
//   refused. The engine turns firing alerts into CI health, the service goes down and an incident opens with the
//   alert's delivery correlated; resolving and clearing restore health and resolve the incident. The Zabbix, Nagios,
//   Datadog, SolarWinds and Splunk payloads are written from those tools' documentation (ADR-073), not recorded.
// - T-634: a real Prometheus Alertmanager (prom/alertmanager in a throwaway container) sends its webhook to the API: a
//   fired alert takes db-01 and its service down and opens an incident; ending it makes Alertmanager send the resolve,
//   which restores health and resolves the incident. The first payload is kept as the recorded fixture.
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { TENANT_SETTINGS_DEFAULTS, loadEnv } from '@openmap/config';
import { RECONCILER } from '@openmap/constants';
import { refTokensOf, type CiType } from '@openmap/contracts';
import { createPrismaClient, Prisma } from '@openmap/db';
import { createGraphRepository, type GraphCi } from '@openmap/graph';
import { createEngine, createMonitoringHealth, type HealthHistoryReader } from '@openmap/bsm-engine';
import { AppModule } from '../app.module.js';
import { JWKS, realmUrl } from '../auth/jwks.provider.js';
import { SIGNING_ALGORITHM } from '../auth/auth.service.js';
import { ROLES } from '../auth/roles.js';

process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
process.env['ANOMALY_INTERVAL_MS'] = '0';
const env = loadEnv();
const prisma = createPrismaClient(env);
const graph = createGraphRepository(env);
const TIMEOUT_MS = 180_000;
const POLL_MS = 500;
const ALERTMANAGER_IMAGE = 'prom/alertmanager:v0.28.1';
const KID = 'openmap-monitoring-key';
const organizationId = randomUUID();
const tenantId = randomUUID();
const short = tenantId.slice(0, 8);
const FIXTURE = fileURLToPath(new URL('../../../../packages/testing/fixtures/monitoring/alertmanager-webhook-v4.json', import.meta.url));
const RESOLVED_FIXTURE = fileURLToPath(new URL('../../../../packages/testing/fixtures/monitoring/alertmanager-webhook-v4-resolved.json', import.meta.url));
const VENDORS = ['prometheus_alertmanager', 'zabbix', 'nagios', 'datadog', 'solarwinds', 'splunk'] as const;
type Vendor = (typeof VENDORS)[number];
const secrets: Record<Vendor, Record<string, string>> = {
  prometheus_alertmanager: { token: 'am-' + randomUUID() },
  zabbix: { token: 'zbx-' + randomUUID() },
  nagios: { signingSecret: 'nagios-' + randomUUID() },
  datadog: { token: 'dd-' + randomUUID() },
  solarwinds: { username: 'orion', password: 'sw-' + randomUUID() },
  splunk: { token: 'splunk-' + randomUUID() },
};
const refOf = (v: Vendor): string => 'openmap/itest/monitoring-' + short + '/' + v;
const integrations = {} as Record<Vendor, string>;
const ci = { web: randomUUID(), db: randomUUID(), sw: randomUUID(), edge: randomUUID(), service: randomUUID() };
const amRaw: string[] = [];
let app: NestFastifyApplication;
let port = 0;
let operatorToken = '';

const silentHistory: HealthHistoryReader = { changes: () => Promise.resolve([]), stateBefore: () => Promise.resolve(new Map()) };
const engine = createEngine({
  prisma,
  graph,
  secrets: { read: () => Promise.reject(new Error('no outbound integrations in this test')) },
  history: silentHistory,
  delivery: { fetchImpl: fetch, sleep: () => Promise.resolve(), now: () => new Date().toISOString() },
  now: () => new Date().toISOString(),
  log: () => undefined,
  get alerts() {
    return monitoring.overlay;
  },
});
const monitoring = createMonitoringHealth({ prisma, graph, healthMap: (t, ids) => engine.healthMap(t, ids), now: () => new Date() });

async function vault(method: 'POST' | 'DELETE', ref: string, data?: Record<string, string>): Promise<void> {
  const path = method === 'POST' ? '/data/' : '/metadata/';
  const res = await fetch(new URL('v1/' + env.OPENBAO_MOUNT + path + ref, env.OPENBAO_ADDR.endsWith('/') ? env.OPENBAO_ADDR : env.OPENBAO_ADDR + '/'), {
    method,
    headers: { 'X-Vault-Token': env.OPENBAO_TOKEN, 'content-type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify({ data }),
  });
  if (!res.ok) throw new Error('OpenBao ' + method + ' ' + String(res.status));
}

async function seedCi(id: string, type: CiType, name: string, identity: Record<string, string>, attributes: Record<string, unknown>): Promise<GraphCi> {
  const now = new Date();
  const layer = type === 'business_service' ? 'applications' : type === 'network_device' ? 'network_security' : 'hardware';
  const tokens = refTokensOf({ type, identity, name, attributes }).map((t) => t.token);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT set_config(${RECONCILER.refTokensSetting}, ${RECONCILER.refTokensWriter}, true)`);
    await tx.ci.create({
      data: {
        id, tenantId, type, identity, identityKey: Object.values(identity).join('|').toLowerCase(), name, displayName: name, code: 'MON-' + id.slice(0, 8).toUpperCase(),
        layer, lifecycle: 'managed', attributes: attributes as Prisma.InputJsonObject, tags: [], refTokens: tokens,
        sourceCollectorId: 'test', sourceNodeId: 'test', sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: now, validFrom: now, checksum: 'c'.repeat(64),
      },
    });
  });
  return { id, tenantId, type, layer, name, displayName: name, lifecycle: 'managed', health: 'healthy', tier: type === 'business_service' ? 1 : null, validFrom: now.toISOString(), validTo: null };
}

async function partOf(member: string): Promise<void> {
  const now = new Date();
  await prisma.relationship.create({
    data: { tenantId, type: 'part_of_service', fromCiId: member, toCiId: ci.service, attributes: {}, sourceCollectorId: 'test', sourceNodeId: 'test', sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: now, validFrom: now },
  });
}

async function post(vendor: Vendor, body: unknown, headers: Record<string, string> = {}, suffix = ''): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  const res = await app.inject({ method: 'POST', url: '/ingest/monitoring/' + integrations[vendor] + suffix, headers: { 'content-type': 'application/json', ...headers }, payload });
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

const bearer = (v: Vendor): Record<string, string> => ({ authorization: 'Bearer ' + (secrets[v]['token'] ?? '') });

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await app.inject({ method: 'POST', url: '/graphql', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + operatorToken }, payload: { query, variables } });
  const body = JSON.parse(res.body) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors !== undefined) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body.data as T;
}

async function alertOf(vendor: Vendor, where: Prisma.MonitoringAlertWhereInput = {}) {
  return prisma.monitoringAlert.findFirst({ where: { tenantId, integrationId: integrations[vendor], ...where }, orderBy: { lastReceivedAt: 'desc' } });
}

async function health(id: string): Promise<string> {
  return (await engine.healthMap(tenantId, [id])).get(id) ?? 'unknown';
}

async function settle(): Promise<void> {
  await monitoring.sync();
  await engine.recomputeTenant(tenantId);
}

async function until<T>(what: string, probe: () => Promise<T | null>, timeoutMs = TIMEOUT_MS / 2): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

describe('monitoring event ingest (integration)', () => {
  beforeAll(async () => {
    const keys = await generateKeyPair(SIGNING_ALGORITHM);
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: SIGNING_ALGORITHM, use: 'sig' };
    operatorToken = await new SignJWT({ tenant: tenantId, preferred_username: 'monitoring-operator', realm_access: { roles: [ROLES.operator] }, azp: env.KEYCLOAK_CLIENT_ID })
      .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: KID })
      .setIssuer(realmUrl(env).toString())
      .setSubject('monitoring-' + randomUUID())
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(keys.privateKey);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(JWKS).useValue(createLocalJWKSet({ keys: [jwk] })).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ['error', 'warn'], rawBody: true });
    // T-634 keeps what the real Alertmanager sent, byte for byte.
    app.getHttpAdapter().getInstance().addHook('preHandler', (request: { url: string; rawBody?: Buffer | string }, _reply: unknown, done: () => void) => {
      if (request.url === '/ingest/monitoring/' + (integrations.prometheus_alertmanager ?? '') && request.rawBody !== undefined) amRaw.push(request.rawBody.toString());
      done();
    });
    await app.init();
    await app.listen(0, '0.0.0.0');
    port = (app.getHttpServer().address() as AddressInfo).port;

    await prisma.organization.create({ data: { id: organizationId, name: 'Monitoring org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: false } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'Monitoring BU', slug: 'mon-' + short } });
    await prisma.tenantSettings.create({ data: { tenantId, ...TENANT_SETTINGS_DEFAULTS } });
    for (const v of VENDORS) {
      await vault('POST', refOf(v), secrets[v]);
      const row = await prisma.integrationConfig.create({
        data: {
          tenantId, category: 'monitoring', vendor: v, name: 'Monitoring ' + v, enabled: true, direction: 'inbound', endpoint: 'https://' + v.replace('_', '-') + '.lab.test/', credentialRef: refOf(v),
          settings: v === 'splunk' ? { urlToken: true } : {}, fieldMappings: [], classMappings: [], subscribedEvents: [],
        },
      });
      integrations[v] = row.id;
    }
    const nodes = [
      await seedCi(ci.web, 'host', 'web-01', { fqdn: 'web-01.lab.test', serialNumber: 'SN-WEB-' + short }, { status: 'ok', primaryIp: '10.20.0.11' }),
      await seedCi(ci.db, 'host', 'db-01', { fqdn: 'db-01.lab.test', serialNumber: 'SN-DB-' + short }, { status: 'ok', primaryIp: '10.20.0.21' }),
      await seedCi(ci.sw, 'network_device', 'core-sw-01', { serialNumber: 'SN-SW-' + short, sysName: 'core-sw-01' }, { status: 'ok', managementIp: '10.0.0.2' }),
      await seedCi(ci.edge, 'network_device', 'Edge router (branch)', { serialNumber: 'SN-EDGE-' + short, sysName: 'br-edge-a' }, { status: 'ok' }),
      await seedCi(ci.service, 'business_service', 'Payments', { name: 'Payments ' + short }, { tier: 1 }),
    ];
    await graph.upsertCis(nodes);
    await partOf(ci.web);
    await partOf(ci.db);
    await settle();
  }, TIMEOUT_MS);

  afterAll(async () => {
    for (const v of VENDORS) await vault('DELETE', refOf(v)).catch(() => undefined);
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await graph.purgeTenant(tenantId);
    if (app !== undefined) await app.close();
    await graph.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  describe('T-633 every vendor', () => {
    it('refuses unknown integrations, wrong credentials and payloads that are not the vendor’s', async () => {
      const unknown = await app.inject({ method: 'POST', url: '/ingest/monitoring/' + randomUUID(), headers: { 'content-type': 'application/json' }, payload: '{}' });
      expect(unknown.statusCode).toBe(404);
      expect((await post('prometheus_alertmanager', { version: '4', alerts: [] }, { authorization: 'Bearer wrong' })).status).toBe(401);
      expect((await post('prometheus_alertmanager', { version: '4', alerts: [] })).status).toBe(401);
      // A URL token is refused where the integration does not allow one.
      expect((await post('zabbix', { event_id: '1', event_value: '1' }, {}, '/' + (secrets.zabbix['token'] ?? ''))).status).toBe(401);
      const foreign = await post('zabbix', { version: '4', alerts: [] }, bearer('zabbix'));
      expect(foreign.status).toBe(400);
      expect(foreign.body['message']).toMatch(/no event_id/u);
      expect(await prisma.monitoringAlert.count({ where: { tenantId } })).toBe(0);
    });

    it('accepts each vendor’s payload, resolves the CIs it can and lists the one it cannot', async () => {
      const am = await post(
        'prometheus_alertmanager',
        {
          version: '4', groupKey: '{}:{alertname="NodeDown"}', truncatedAlerts: 0, status: 'firing', receiver: 'openmap', groupLabels: { alertname: 'NodeDown' },
          commonLabels: { alertname: 'NodeDown' }, commonAnnotations: {}, externalURL: 'http://alertmanager.lab.test:9093',
          alerts: [{ status: 'firing', labels: { alertname: 'NodeDown', instance: 'web-01.lab.test:9100', severity: 'critical' }, annotations: { summary: 'node exporter unreachable' }, startsAt: new Date().toISOString(), endsAt: '0001-01-01T00:00:00Z', generatorURL: '', fingerprint: 'itest-' + short }],
        },
        bearer('prometheus_alertmanager'),
      );
      expect(am).toEqual({ status: 202, body: { accepted: 1, resolved: 1, unresolved: 0, ignored: 0 } });
      const zabbix = await post('zabbix', { event_source: '0', event_value: '1', event_id: '9001', event_name: 'High disk latency', event_nseverity: '3', host_host: 'db-01.lab.test', host_name: 'DB 01', host_ip: '10.20.0.21' }, bearer('zabbix'));
      expect(zabbix.body).toMatchObject({ accepted: 1, resolved: 1 });
      const nagiosBody = JSON.stringify({ notification_type: 'PROBLEM', host_name: 'core-sw-01', host_state: 'DOWN', output: 'PING CRITICAL' });
      const ts = String(Math.floor(Date.now() / 1000));
      const signature = 'v1=' + createHmac('sha256', secrets.nagios['signingSecret'] ?? '').update(ts + '.' + nagiosBody).digest('hex');
      const signedHeaders = { 'content-type': 'application/json', 'x-openmap-timestamp': ts, 'x-openmap-signature': signature };
      const signed = await app.inject({ method: 'POST', url: '/ingest/monitoring/' + integrations.nagios, payload: nagiosBody, headers: signedHeaders });
      expect(signed.statusCode).toBe(202);
      const tampered = await app.inject({ method: 'POST', url: '/ingest/monitoring/' + integrations.nagios, payload: nagiosBody.replace('DOWN', 'UP'), headers: signedHeaders });
      expect(tampered.statusCode).toBe(401);
      const datadog = await post('datadog', { alert_id: '777', alert_cycle_key: 'cycle-' + short, title: '[Triggered] latency', alert_transition: 'Triggered', alert_type: 'warning', priority: 'P3', tags: 'env:prod,openmap_ci_id:' + ci.db, date: String(Date.now()) }, bearer('datadog'));
      expect(datadog.body).toMatchObject({ resolved: 1 });
      const basic = { authorization: 'Basic ' + Buffer.from('orion:' + (secrets.solarwinds['password'] ?? '')).toString('base64') };
      const solarwinds = await post('solarwinds', { alert_name: 'Node is down', alert_object_id: 'obj-' + short, severity: 'Critical', action: 'trigger', node_name: 'edge-rtr-02', ip_address: '10.9.0.1' }, basic);
      expect(solarwinds.body).toEqual({ accepted: 1, resolved: 0, unresolved: 1, ignored: 0 });
      const splunk = await post('splunk', { result: { host: 'web-01', severity: 'low' }, sid: 'sid-1', results_link: 'https://splunk.lab.test/x', search_name: 'Web 5xx spike', owner: 'admin', app: 'search' }, {}, '/' + (secrets.splunk['token'] ?? ''));
      expect(splunk.status).toBe(202);

      expect(await alertOf('prometheus_alertmanager')).toMatchObject({ ciId: ci.web, resolution: 'identity', severity: 'critical', effect: 'down', status: 'firing' });
      expect(await alertOf('zabbix')).toMatchObject({ ciId: ci.db, resolution: 'identity', severity: 'medium', effect: 'degraded', fingerprint: '9001' });
      expect(await alertOf('nagios')).toMatchObject({ ciId: ci.sw, severity: 'critical', effect: 'down' });
      expect(await alertOf('datadog')).toMatchObject({ ciId: ci.db, resolution: 'ci_id', severity: 'medium' });
      expect(await alertOf('solarwinds')).toMatchObject({ ciId: null, resolution: null, severity: 'critical' });
      const sp = await alertOf('splunk');
      expect(sp).toMatchObject({ ciId: ci.web, severity: 'low', effect: 'degraded' });
      expect(sp?.expiresAt).not.toBeNull();
      // Each request is an inbound delivery, recorded with the event that woke the engine.
      const deliveries = await prisma.integrationDelivery.findMany({ where: { tenantId, direction: 'in' } });
      expect(deliveries).toHaveLength(VENDORS.length);
      const events = await prisma.outboxEvent.findMany({ where: { tenantId, type: 'openmap.integration.delivery.succeeded' } });
      expect(events).toHaveLength(VENDORS.length);
      expect(events.every((e) => (e.envelope as { data: { kind?: string } }).data.kind === 'monitoring')).toBe(true);
      expect((await prisma.integrationStatus.findUnique({ where: { integrationId: integrations.zabbix } }))?.health).toBe('healthy');
    });

    it('lists the unresolved alert, and a mapping resolves it now and on its next message', async () => {
      const list = await gql<{ monitoringAlerts: { firing: number; unresolved: number; alerts: Array<{ vendor: string; ci: { id: string } | null; targets: Array<{ kind: string; value: string }> }> } }>(
        'query { monitoringAlerts(unresolvedOnly: true) { firing unresolved alerts { vendor ci { id } targets { kind value } } } }',
      );
      expect(list.monitoringAlerts.firing).toBe(VENDORS.length);
      expect(list.monitoringAlerts.unresolved).toBe(1);
      expect(list.monitoringAlerts.alerts.map((a) => a.vendor)).toEqual(['solarwinds']);
      expect(list.monitoringAlerts.alerts[0]?.targets).toEqual([{ kind: 'ip', value: '10.9.0.1' }, { kind: 'hostname', value: 'edge-rtr-02' }]);
      const mapped = await gql<{ mapMonitoringSource: { sourceKey: string; ci: { id: string } } }>('mutation M($k: String!, $c: UUID!) { mapMonitoringSource(sourceKey: $k, ciId: $c) { sourceKey ci { id } } }', { k: 'Edge-Rtr-02', c: ci.edge });
      expect(mapped.mapMonitoringSource).toEqual({ sourceKey: 'edge-rtr-02', ci: { id: ci.edge } });
      expect(await alertOf('solarwinds')).toMatchObject({ ciId: ci.edge, resolution: 'mapping' });
      const basic = { authorization: 'Basic ' + Buffer.from('orion:' + (secrets.solarwinds['password'] ?? '')).toString('base64') };
      const again = await post('solarwinds', { alert_name: 'Interface down', alert_object_id: 'obj2-' + short, severity: 'Warning', action: 'trigger', node_name: 'edge-rtr-02' }, basic);
      expect(again.body).toMatchObject({ resolved: 1, unresolved: 0 });
      expect((await gql<{ monitoringAlerts: { unresolved: number } }>('query { monitoringAlerts { unresolved } }')).monitoringAlerts.unresolved).toBe(0);
    });

    it('turns firing alerts into CI and service health and an incident, and restores both when they end', async () => {
      await settle();
      expect(await health(ci.web)).toBe('down');
      expect(await health(ci.db)).toBe('degraded');
      expect(await health(ci.sw)).toBe('down');
      expect(await health(ci.edge)).toBe('down');
      expect(await health(ci.service)).toBe('down');
      const ciHealth = await gql<{ ci: { health: string } }>('query C($id: UUID!) { ci(id: $id) { health } }', { id: ci.web });
      expect(ciHealth.ci.health).toBe('down');
      const incident = await prisma.incident.findFirst({ where: { tenantId, state: 'open', affectedServiceCiIds: { has: ci.service } } });
      expect(incident?.rootCauseCiId).toBe(ci.web);
      const amEvent = (await alertOf('prometheus_alertmanager'))?.lastEventId;
      expect(incident?.correlatedEventIds).toContain(amEvent);

      // Alertmanager resolves its alert; the operator clears Splunk's; Datadog recovers and Zabbix recovers.
      const resolvedAm = await post('prometheus_alertmanager', { version: '4', status: 'resolved', alerts: [{ status: 'resolved', labels: { alertname: 'NodeDown', instance: 'web-01.lab.test:9100' }, startsAt: new Date().toISOString(), endsAt: new Date().toISOString(), fingerprint: 'itest-' + short }] }, bearer('prometheus_alertmanager'));
      expect(resolvedAm.status).toBe(202);
      const splunkAlert = await alertOf('splunk');
      await gql('mutation C($id: UUID!) { clearMonitoringAlert(id: $id) { status } }', { id: splunkAlert?.id });
      await post('datadog', { alert_id: '777', alert_cycle_key: 'cycle-' + short, alert_transition: 'Recovered', alert_type: 'success', tags: 'openmap_ci_id:' + ci.db }, bearer('datadog'));
      await post('zabbix', { event_source: '0', event_value: '0', event_id: '9001', host_host: 'db-01.lab.test' }, bearer('zabbix'));
      expect(await alertOf('prometheus_alertmanager')).toMatchObject({ status: 'resolved', severity: 'critical', title: 'NodeDown: node exporter unreachable', receivedCount: 2 });
      await settle();
      expect(await health(ci.web)).toBe('healthy');
      expect(await health(ci.db)).toBe('healthy');
      expect(await health(ci.sw)).toBe('down');
      expect(await health(ci.service)).toBe('healthy');
      expect((await prisma.incident.findUnique({ where: { id: incident?.id ?? '' } }))?.state).toBe('resolved');
    });
  });

  describe('T-634 a real Prometheus Alertmanager', () => {
    const name = 'openmap-itest-am-' + short;
    let configDir = '';
    let amUrl = '';

    beforeAll(async () => {
      configDir = mkdtempSync(join(tmpdir(), 'openmap-am-'));
      const config = [
        'route:',
        '  receiver: openmap',
        '  group_by: [alertname, instance]',
        '  group_wait: 1s',
        '  group_interval: 1s',
        '  repeat_interval: 1h',
        'receivers:',
        '  - name: openmap',
        '    webhook_configs:',
        '      - url: http://host.docker.internal:' + String(port) + '/ingest/monitoring/' + integrations.prometheus_alertmanager,
        '        send_resolved: true',
        '        http_config:',
        '          authorization:',
        '            type: Bearer',
        '            credentials: ' + (secrets.prometheus_alertmanager['token'] ?? ''),
        '',
      ].join('\n');
      writeFileSync(join(configDir, 'alertmanager.yml'), config);
      execFileSync('docker', ['run', '--rm', '-d', '--name', name, '--add-host', 'host.docker.internal:host-gateway', '-p', '127.0.0.1::9093', '-v', configDir + ':/etc/alertmanager:ro', ALERTMANAGER_IMAGE, '--config.file=/etc/alertmanager/alertmanager.yml', '--cluster.listen-address=']);
      const mapped = execFileSync('docker', ['port', name, '9093/tcp']).toString().trim().split('\n')[0] ?? '';
      amUrl = 'http://' + mapped;
      await until('Alertmanager ready', async () => ((await fetch(amUrl + '/-/ready').catch(() => null))?.ok === true ? true : null));
    }, TIMEOUT_MS);

    afterAll(() => {
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      } catch {
        // The container may already be gone.
      }
      rmSync(configDir, { recursive: true, force: true });
    });

    async function fire(endsAt?: string): Promise<void> {
      const alert = { labels: { alertname: 'NodeExporterDown', instance: 'db-01.lab.test:9100', job: 'node', severity: 'critical' }, annotations: { summary: 'db-01 node exporter is not answering' }, startsAt: new Date(Date.now() - 1000).toISOString(), ...(endsAt === undefined ? {} : { endsAt }) };
      const res = await fetch(amUrl + '/api/v2/alerts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([alert]) });
      expect(res.ok).toBe(true);
    }

    it('delivers a fired alert: db-01 and its service go down; ending it resolves both', async () => {
      await fire();
      const firing = await until('the Alertmanager alert', () => prisma.monitoringAlert.findFirst({ where: { tenantId, integrationId: integrations.prometheus_alertmanager, status: 'firing', title: { startsWith: 'NodeExporterDown' } } }));
      expect(firing).toMatchObject({ ciId: ci.db, resolution: 'identity', severity: 'critical', effect: 'down' });
      expect(amRaw.length).toBeGreaterThan(0);
      if (!existsSync(FIXTURE)) {
        mkdirSync(join(FIXTURE, '..'), { recursive: true });
        writeFileSync(FIXTURE, JSON.stringify(JSON.parse(amRaw[amRaw.length - 1] ?? '{}'), null, 2) + '\n');
      }
      await settle();
      expect(await health(ci.db)).toBe('down');
      expect(await health(ci.service)).toBe('down');
      const incident = await prisma.incident.findFirst({ where: { tenantId, state: 'open', affectedServiceCiIds: { has: ci.service } } });
      expect(incident?.rootCauseCiId).toBe(ci.db);
      expect(incident?.correlatedEventIds).toContain(firing.lastEventId);

      await fire(new Date().toISOString());
      await until('the resolve from Alertmanager', () => prisma.monitoringAlert.findFirst({ where: { id: firing.id, status: 'resolved' } }));
      const resolvedRaw = amRaw.filter((r) => r.includes('NodeExporterDown') && r.includes('"status":"resolved"')).at(-1);
      expect(resolvedRaw).toBeDefined();
      if (!existsSync(RESOLVED_FIXTURE)) writeFileSync(RESOLVED_FIXTURE, JSON.stringify(JSON.parse(resolvedRaw ?? '{}'), null, 2) + '\n');
      await settle();
      expect(await health(ci.db)).toBe('healthy');
      expect(await health(ci.service)).toBe('healthy');
      expect((await prisma.incident.findUnique({ where: { id: incident?.id ?? '' } }))?.state).toBe('resolved');
    }, TIMEOUT_MS);
  });
});
