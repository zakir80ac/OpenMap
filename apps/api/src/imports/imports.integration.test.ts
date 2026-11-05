// T-170 REQ-CMDB-033 REQ-CMDB-036 (ADR-032) — import and export through the API against the compose stack, with the
// compose reconciler consuming the results queue: a discovery result creates a host; a spreadsheet then names that host
// with a different vendor and a new attribute, adds a new host and carries a row with no name. The preview reads the
// file with a proposed mapping and refuses the bad row; the run queues the rest as the import source; after
// reconciliation the discovered vendor is unchanged, the new attribute is filled in, the new host exists as "managed"
// at import confidence, and the job counts what it created. The CI export returns that host in CSV, XLSX and JSON,
// and a CSV export re-imports with no mapping given.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type GenerateKeyPairResult } from 'jose';
import { loadEnv } from '@openmap/config';
import { CONTRACT_VERSIONS, IMPORTS, RECONCILIATION } from '@openmap/constants';
import { createPrismaClient } from '@openmap/db';
import { createResultsQueue } from '@openmap/scheduler/results-queue';
import { AppModule } from '../app.module.js';
import { JWKS, realmUrl } from '../auth/jwks.provider.js';
import { SIGNING_ALGORITHM } from '../auth/auth.service.js';
import { ROLES } from '../auth/roles.js';

const env = loadEnv();
const prisma = createPrismaClient(env);
const KID = 'openmap-import-key';
const TIMEOUT_MS = 180_000;
const POLL_MS = 500;
const tenantId = randomUUID();
const organizationId = randomUUID();
const stamp = randomUUID().slice(0, 8);
const known = 'SN-IMP-' + stamp + '-1';
const fresh = 'SN-IMP-' + stamp + '-2';

let app: NestFastifyApplication;
let keys: GenerateKeyPairResult;

async function token(roles: string[]): Promise<string> {
  return new SignJWT({ tenant: tenantId, preferred_username: 'importer', realm_access: { roles }, azp: env.KEYCLOAK_CLIENT_ID })
    .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: KID })
    .setIssuer(realmUrl(env).toString())
    .setSubject('import-' + randomUUID())
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(keys.privateKey);
}

async function gql<T>(query: string, variables: Record<string, unknown>, bearer: string): Promise<{ data?: T; errors?: Array<{ message: string }> }> {
  const res = await app.inject({ method: 'POST', url: '/graphql', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + bearer }, payload: { query, variables } });
  return JSON.parse(res.body) as { data?: T; errors?: Array<{ message: string }> };
}

async function until<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const v = await read();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting for the reconciler');
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

const PREVIEW = 'mutation P($input: ImportInput!) { previewImport(input: $input) { headers mapping rows accepted rejected rejectedRows { row reason } byType sample } }';
const RUN = 'mutation R($input: ImportInput!) { runImport(input: $input) { id rows accepted rejected runId created } }';
const JOBS = 'query { importJobs { id created accepted } }';

describe('imports and exports (integration)', () => {
  beforeAll(async () => {
    keys = await generateKeyPair(SIGNING_ALGORITHM);
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: SIGNING_ALGORITHM, use: 'sig' };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(JWKS).useValue(createLocalJWKSet({ keys: [jwk] })).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ bodyLimit: IMPORTS.maxBodyBytes }), { logger: ['error', 'warn'] });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await prisma.organization.create({ data: { id: organizationId, name: 'Import org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: true } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'Import BU', slug: 'import-' + stamp } });
    // Discovery has seen one host first.
    const queue = createResultsQueue(env);
    const now = new Date().toISOString();
    const runId = randomUUID();
    await queue.publish({
      jobId: runId, runId, tenantId, collectorId: 'ssh_agentless', nodeId: 'node-test', status: 'success', startedAt: now, finishedAt: now,
      cis: [{ type: 'host', identity: { serialNumber: known }, name: 'srv-imp-known', attributes: { vendor: 'Dell', memoryGb: 256 }, tags: [], externalIds: [], observedAt: now }],
      relationships: [], samples: [], evidence: [], errors: [],
      metrics: { targetsAttempted: 1, targetsReached: 1, cisEmitted: 1, relationshipsEmitted: 0, durationMs: 1 },
      contractVersion: CONTRACT_VERSIONS.collector,
    });
    await queue.close();
    await until(() => prisma.ci.findFirst({ where: { tenantId, name: 'srv-imp-known', validTo: null } }));
  }, TIMEOUT_MS);

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  });

  it('imports a sheet without overwriting discovery and exports the result', async () => {
    const operator = await token([ROLES.operator]);
    const csv = ['type,name,identity.serialNumber,attribute.vendor,attribute.costCentre', 'host,srv-imp-known,' + known + ',HP,CC-100', 'host,srv-imp-new,' + fresh + ',Lenovo,CC-200', 'host,,SN-NONAME,HP,CC-300'].join('\r\n');
    const input = { filename: 'hosts.csv', format: 'csv', contentBase64: Buffer.from(csv, 'utf8').toString('base64') };

    const preview = await gql<{ previewImport: { rows: number; accepted: number; rejected: number; rejectedRows: Array<{ row: number; reason: string }>; byType: Record<string, number>; mapping: { columns: Record<string, string> } } }>(PREVIEW, { input }, operator);
    expect(preview.errors).toBeUndefined();
    expect(preview.data?.previewImport).toMatchObject({ rows: 3, accepted: 2, rejected: 1, rejectedRows: [{ row: 3, reason: 'no name' }], byType: { host: 2 } });
    expect(preview.data?.previewImport.mapping.columns['identity.serialNumber']).toBe('identity.serialNumber');
    const viewer = await gql<{ previewImport: unknown }>(PREVIEW, { input }, await token([ROLES.analyst]));
    expect(viewer.errors?.[0]?.message).toMatch(/roles/i);

    const run = await gql<{ runImport: { id: string; accepted: number; runId: string } }>(RUN, { input }, operator);
    expect(run.errors).toBeUndefined();
    expect(run.data?.runImport.accepted).toBe(2);

    const created = await until(() => prisma.ci.findFirst({ where: { tenantId, name: 'srv-imp-new', validTo: null } }));
    expect(created).toMatchObject({ lifecycle: IMPORTS.createdLifecycle, sourceCollectorId: IMPORTS.collectorId, sourceConfidence: RECONCILIATION.importSeedConfidence, sourceRunId: run.data?.runImport.runId });
    expect(created.attributes).toMatchObject({ vendor: 'Lenovo', costCentre: 'CC-200' });
    const knownCi = await until(async () => {
      const ci = await prisma.ci.findFirst({ where: { tenantId, name: 'srv-imp-known', validTo: null } });
      return ci !== null && (ci.attributes as Record<string, unknown>)['costCentre'] !== undefined ? ci : null;
    });
    // Discovery's vendor stays; the import only filled what discovery had not observed.
    expect(knownCi.attributes).toMatchObject({ vendor: 'Dell', memoryGb: 256, costCentre: 'CC-100' });
    expect(knownCi.sourceCollectorId).toBe('ssh_agentless');
    const jobs = await gql<{ importJobs: Array<{ id: string; created: number; accepted: number }> }>(JOBS, {}, operator);
    expect(jobs.data?.importJobs[0]).toMatchObject({ id: run.data?.runImport.id, created: 1, accepted: 2 });

    const bearer = 'Bearer ' + operator;
    const csvOut = await app.inject({ method: 'GET', url: '/export/cis?format=csv&types=host', headers: { authorization: bearer } });
    expect(csvOut.statusCode).toBe(200);
    expect(csvOut.headers['content-type']).toContain('text/csv');
    expect(csvOut.body).toContain('identity.serialNumber');
    expect(csvOut.body).toContain('srv-imp-new');
    const jsonOut = await app.inject({ method: 'GET', url: '/export/cis?format=json&types=host', headers: { authorization: bearer } });
    const rows = JSON.parse(jsonOut.body) as Array<{ name: string; identity: Record<string, string> }>;
    expect(rows.map((r) => r.name).sort()).toEqual(['srv-imp-known', 'srv-imp-new']);
    const xlsxOut = await app.inject({ method: 'GET', url: '/export/cis?format=xlsx', headers: { authorization: bearer } });
    expect(xlsxOut.headers['content-type']).toContain('spreadsheetml');
    expect(xlsxOut.rawPayload.subarray(0, 2).toString('latin1')).toBe('PK');
    const anonymous = await app.inject({ method: 'GET', url: '/export/cis?format=csv' });
    expect(anonymous.statusCode).toBe(401);

    // A CSV export re-imports as it is: its headers are targets, so the proposed mapping accepts every row.
    const again = await gql<{ previewImport: { accepted: number; rejected: number } }>(PREVIEW, { input: { filename: 'export.csv', format: 'csv', contentBase64: Buffer.from(csvOut.body, 'utf8').toString('base64') } }, operator);
    expect(again.data?.previewImport).toMatchObject({ accepted: 2, rejected: 0 });
  }, TIMEOUT_MS * 2);

  it('reads an XLSX export back', async () => {
    const operator = await token([ROLES.operator]);
    const xlsx = await app.inject({ method: 'GET', url: '/export/cis?format=xlsx&types=host', headers: { authorization: 'Bearer ' + operator } });
    const preview = await gql<{ previewImport: { accepted: number; byType: Record<string, number>; headers: string[] } }>(PREVIEW, { input: { filename: 'export.xlsx', format: 'xlsx', contentBase64: xlsx.rawPayload.toString('base64') } }, operator);
    expect(preview.errors).toBeUndefined();
    expect(preview.data?.previewImport.headers.slice(0, 3)).toEqual(['type', 'name', 'tags']);
    expect(preview.data?.previewImport.byType).toEqual({ host: 2 });
  }, TIMEOUT_MS);
});
