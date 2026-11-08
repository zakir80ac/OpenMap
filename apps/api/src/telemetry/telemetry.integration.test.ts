// T-495 REQ-UI-027 — the health and telemetry fleet against the compose stack, on the tenant with the most hosts (the
// scale-1 estate when it is loaded):
// - the snapshot joins ClickHouse samples, Postgres CIs and graph health: hosts carry CPU and memory, network gear
//   throughput, storage IOPS, applications Apdex (memory where the estate samples it), and every row has a category;
// - warm pages with category, health and text filters and each sort key stay inside the screen interaction budget at
//   p95 (PERF_BUDGETS.screenInteractionP95Ms), so the table's p95 holds on 100k CIs;
// - telemetryFleet over GraphQL returns the same page with each row's CI.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type GenerateKeyPairResult } from 'jose';
import { loadEnv } from '@openmap/config';
import { PERF_BUDGETS, TELEMETRY } from '@openmap/constants';
import { FLEET_SORTS, type CiLayer } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { AppModule } from '../app.module.js';
import { JWKS, realmUrl } from '../auth/jwks.provider.js';
import { SIGNING_ALGORITHM } from '../auth/auth.service.js';
import { ROLES } from '../auth/roles.js';
import { TelemetryService, type FleetFilter } from './telemetry.service.js';

process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
const env = loadEnv();
const prisma = createPrismaClient(env);
const KID = 'openmap-telemetry-key';
const TIMEOUT_MS = 300_000;
const P95 = 0.95;

let app: NestFastifyApplication;
let keys: GenerateKeyPairResult;
let baseUrl = '';
let tenant = '';

describe('telemetry fleet (integration)', () => {
  beforeAll(async () => {
    const populated = await prisma.ci.groupBy({ by: ['tenantId'], where: { type: 'host', validTo: null }, _count: { _all: true }, orderBy: { _count: { tenantId: 'desc' } }, take: 1 });
    tenant = populated[0]?.tenantId ?? '';
    expect(tenant).not.toBe('');
    keys = await generateKeyPair(SIGNING_ALGORITHM);
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: SIGNING_ALGORITHM, use: 'sig' };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(JWKS).useValue(createLocalJWKSet({ keys: [jwk] })).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ['error', 'warn'] });
    await app.init();
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  }, TIMEOUT_MS);

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it('joins the three stores into one row per measured CI', async () => {
    const service = app.get(TelemetryService);
    const started = Date.now();
    const snapshot = await service.snapshot(tenant);
    console.log(JSON.stringify({ msg: 'telemetry snapshot', tenant, rows: snapshot.rows.length, buildMs: Date.now() - started }));
    expect(snapshot.rows.length).toBeGreaterThan(0);
    const byLayer = (layer: CiLayer) => snapshot.rows.filter((r) => r.layer === layer);
    expect(byLayer('hardware').some((r) => r.cpu !== null)).toBe(true);
    expect(byLayer('network_security').some((r) => r.throughput !== null)).toBe(true);
    expect(byLayer('storage').some((r) => r.iops !== null)).toBe(true);
    expect(byLayer('applications').some((r) => r.apdex !== null)).toBe(true);
    expect(snapshot.rows.filter((r) => r.site !== null).length).toBeGreaterThan(0);
    expect(snapshot.rows.filter((r) => r.address !== null).length).toBeGreaterThan(0);
  }, TIMEOUT_MS);

  it('answers warm pages inside the screen budget at p95', async () => {
    const service = app.get(TelemetryService);
    await service.snapshot(tenant);
    const filters: FleetFilter[] = [
      { layers: null, health: null, text: null },
      { layers: ['hardware', 'virtualization'], health: null, text: null },
      { layers: null, health: ['down', 'degraded'], text: null },
      { layers: ['network_security'], health: null, text: 'ryd' },
      { layers: null, health: null, text: 'db' },
    ];
    const timings: number[] = [];
    const byFilter = filters.map(() => 0);
    for (const sort of FLEET_SORTS)
      for (const [f, filter] of filters.entries())
        for (const offset of [0, TELEMETRY.defaultPageSize * 3]) {
          const t0 = performance.now();
          const page = await service.fleet(tenant, filter, sort, TELEMETRY.defaultPageSize, offset);
          const ms = performance.now() - t0;
          timings.push(ms);
          byFilter[f] = Math.max(byFilter[f] ?? 0, ms);
          expect(page.items.length).toBeLessThanOrEqual(TELEMETRY.defaultPageSize);
          expect(page.total).toBeGreaterThanOrEqual(page.items.length);
        }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.min(timings.length - 1, Math.floor(timings.length * P95))] ?? Infinity;
    console.log(JSON.stringify({ msg: 'telemetry pages', pages: timings.length, p50Ms: Number((timings[Math.floor(timings.length / 2)] ?? 0).toFixed(1)), p95Ms: Number(p95.toFixed(1)), maxMs: Number((timings.at(-1) ?? 0).toFixed(1)), maxMsByFilter: byFilter.map((x) => Number(x.toFixed(1))) }));
    expect(p95).toBeLessThan(PERF_BUDGETS.screenInteractionP95Ms);
  }, TIMEOUT_MS);

  it('serves telemetryFleet over GraphQL with each row’s CI', async () => {
    const jwt = await new SignJWT({ tenant, preferred_username: 'telemetry-user', realm_access: { roles: [ROLES.analyst] }, azp: env.KEYCLOAK_CLIENT_ID })
      .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: KID })
      .setIssuer(realmUrl(env).toString())
      .setSubject('telemetry-' + randomUUID())
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(keys.privateKey);
    const res = await fetch(baseUrl + '/graphql', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + jwt, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query F($f: FleetFilter) { telemetryFleet(filter: $f, sort: cpu, first: 5) { total healthy degraded down unknown asOf items { ci { id type layer displayName } site address health cpu memory } } }',
        variables: { f: { layers: ['hardware'] } },
      }),
    });
    const body = (await res.json()) as { data?: { telemetryFleet: { total: number; items: Array<{ ci: { layer: string }; cpu: number | null }> } }; errors?: unknown };
    expect(body.errors).toBeUndefined();
    const fleet = body.data?.telemetryFleet;
    expect(fleet?.total).toBeGreaterThan(0);
    expect(fleet?.items.length).toBe(Math.min(5, fleet?.total ?? 0));
    expect(fleet?.items.every((r) => r.ci.layer === 'hardware')).toBe(true);
    const cpus = (fleet?.items ?? []).map((r) => r.cpu ?? -1);
    expect(cpus).toEqual([...cpus].sort((a, b) => b - a));
  }, TIMEOUT_MS);
});
