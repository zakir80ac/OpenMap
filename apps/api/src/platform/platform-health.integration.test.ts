// T-615 REQ-PERF-005 (ADR-071) — Query.platformHealth through the API module against the compose stack's Prometheus:
// the OpenMap services and ClickHouse are scraped targets with their memory and event-loop figures, every SLO indicator
// is evaluated (none down), a day's window measures GraphQL latency, the committed perf results are judged against the
// budgets, the query is for administrators only, and the read is counted for Prometheus.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { loadEnv } from '@openmap/config';
import { PLATFORM_HEALTH } from '@openmap/constants';
import { PLATFORM_SLI_IDS } from '@openmap/telemetry';
import { AppModule } from '../app.module.js';
import { JWKS, realmUrl } from '../auth/jwks.provider.js';
import { SIGNING_ALGORITHM } from '../auth/auth.service.js';
import { ROLES } from '../auth/roles.js';
import type { PlatformHealthView } from './platform-health.service.js';

process.env['PERF_RESULTS_DIR'] = fileURLToPath(new URL('../../../../docs/evidence/perf/', import.meta.url));
process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
process.env['ANOMALY_INTERVAL_MS'] = '0';
const env = loadEnv();
const KID = 'openmap-platform-key';
const QUERY = `query P($w: Int) { platformHealth(windowMinutes: $w) {
  observedAt windowMinutes prometheus { reachable version error }
  targets { service job instance health lastScrapeAt scrapeDurationMs lastError requestRate p95Ms errorRatio eventLoopP99Ms residentBytes cpuCores }
  stores { store up probeMs } outbox { pending oldestAgeSeconds deliveredPerSecond failuresPerSecond }
  queues { queue waiting active delayed failed } slis { id unit value objective status }
  alerts { name sli severity state subject activeAt value }
  budgets { configured invalid checks { result measure page value budget comparison withinBudget measuredAt } } } }`;
let app: NestFastifyApplication;
let privateKey: KeyLike;

async function token(role: string): Promise<string> {
  return new SignJWT({ tenant: randomUUID(), preferred_username: 'platform-' + role, realm_access: { roles: [role] }, azp: env.KEYCLOAK_CLIENT_ID })
    .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: KID })
    .setIssuer(realmUrl(env).toString())
    .setSubject('platform-' + randomUUID())
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

async function query(role: string, w?: number): Promise<{ data: { platformHealth: PlatformHealthView } | null; errors?: Array<{ message: string }> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (await token(role)) },
    payload: { query: QUERY, variables: w === undefined ? {} : { w } },
  });
  return JSON.parse(res.body) as { data: { platformHealth: PlatformHealthView } | null; errors?: Array<{ message: string }> };
}

describe('platformHealth (integration)', () => {
  beforeAll(async () => {
    const keys = await generateKeyPair(SIGNING_ALGORITHM);
    privateKey = keys.privateKey;
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: SIGNING_ALGORITHM, use: 'sig' };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(JWKS).useValue(createLocalJWKSet({ keys: [jwk] })).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ['error', 'warn'] });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 120_000);

  afterAll(async () => {
    if (app !== undefined) await app.close();
  });

  it('reads the scrape targets and every indicator from Prometheus', async () => {
    const body = await query(ROLES.admin);
    expect(body.errors).toBeUndefined();
    const h = body.data?.platformHealth as PlatformHealthView;
    expect(h.prometheus.reachable).toBe(true);
    expect(h.prometheus.version).toMatch(/^\d+\.\d+\.\d+/u);
    expect(h.windowMinutes).toBe(PLATFORM_HEALTH.windowsMinutes[0]);
    for (const service of PLATFORM_HEALTH.services) {
      const t = h.targets.find((x) => x.service === service);
      expect(t?.health, service).toBe('up');
      expect(t?.residentBytes ?? 0, service).toBeGreaterThan(0);
      expect(t?.eventLoopP99Ms, service).not.toBeNull();
      expect(t?.lastScrapeAt, service).not.toBeNull();
    }
    expect(h.targets.find((t) => t.service === 'clickhouse')?.health).toBe('up');
    expect(h.slis.map((s) => s.id)).toEqual([...PLATFORM_SLI_IDS]);
    expect(h.slis.find((s) => s.id === 'targets_down')).toMatchObject({ value: 0, status: 'ok' });
    expect(h.stores.map((s) => s.store)).toEqual([...PLATFORM_HEALTH.stores]);
  });

  it('measures GraphQL latency over a day against the screen budget', async () => {
    const day = PLATFORM_HEALTH.windowsMinutes[PLATFORM_HEALTH.windowsMinutes.length - 1];
    const body = await query(ROLES.admin, day);
    expect(body.errors).toBeUndefined();
    const p95 = body.data?.platformHealth.slis.find((s) => s.id === 'graphql_p95_seconds');
    expect(p95?.value).not.toBeNull();
    expect(['ok', 'breach']).toContain(p95?.status);
    const api = body.data?.platformHealth.targets.find((t) => t.service === 'api');
    expect(api?.requestRate ?? 0).toBeGreaterThan(0);
  });

  it('judges the committed perf results against the budgets', async () => {
    const b = (await query(ROLES.admin)).data?.platformHealth.budgets;
    expect(b?.configured).toBe(true);
    expect(b?.invalid).toEqual([]);
    expect(b?.checks.find((c) => c.result === 'screen-interaction')).toMatchObject({ measure: 'p95Ms', comparison: 'max', withinBudget: true });
    expect(b?.checks.find((c) => c.result === 'graph-render')).toMatchObject({ measure: 'fps', comparison: 'min' });
    expect(b?.checks.filter((c) => c.result === 'lighthouse').length).toBeGreaterThan(0);
  });

  it('is for administrators only, rejects other windows, and counts reads', async () => {
    const refused = await query(ROLES.analyst);
    expect(refused.errors?.[0]?.message).toMatch(/forbidden|role/iu);
    const odd = await query(ROLES.admin, 7);
    expect(odd.errors?.[0]?.message).toMatch(/windowMinutes/u);
    const res = await app.inject({ method: 'GET', url: env.METRICS_PATH });
    expect(res.body).toMatch(new RegExp(PLATFORM_HEALTH.metrics.reads + '\\{outcome="ok"\\} [1-9]', 'u'));
  });
});
