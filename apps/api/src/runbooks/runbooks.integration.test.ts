// T-471 REQ-BSM-005 (ADR-048) — runbooks through GraphQL against the compose stack (Postgres, OpenBao), in a tenant of
// its own (the operator also holds the admin role, which configuring an integration needs):
// - the catalogue refuses an automation on an ITSM integration;
// - a runbook attached to a saved scenario is offered to an incident of that scenario's root cause;
// - attached to the incident, it carries the estimate, the sum of its step minutes;
// - with the tenant's outbound integrations off, the automated step is recorded `failed` with the gate's reason;
// - switched on, the step launches the AWX job template: the in-test receiver gets
//   POST /api/v2/job_templates/{action}/launch/ with the incident as extra vars and the credential from OpenBao as a
//   bearer token, and the run is `triggered` with the remote job id;
// - the manual step is `done`, and the minutes still to go fall to zero.
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type GenerateKeyPairResult } from 'jose';
import { loadEnv, TENANT_SETTINGS_DEFAULTS } from '@openmap/config';
import { createPrismaClient } from '@openmap/db';
import { AppModule } from '../app.module.js';
import { JWKS, realmUrl } from '../auth/jwks.provider.js';
import { SIGNING_ALGORITHM } from '../auth/auth.service.js';
import { ROLES } from '../auth/roles.js';
import { SecretsService } from '../integrations/secrets.service.js';

// The step's automation crosses the deployment gate; the tenant gate is what the test switches.
process.env['FEATURE_OUTBOUND_INTEGRATIONS'] = 'true';
process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
const env = loadEnv();
const prisma = createPrismaClient(env);
const KID = 'openmap-runbooks-key';
const TIMEOUT_MS = 120_000;
const tenantId = randomUUID();
const organizationId = randomUUID();
const stamp = randomUUID().slice(0, 8);
const credentialRef = 'test/runbooks-' + stamp;
const AWX_TOKEN = 'awx-' + stamp;
const JOB_TEMPLATE = '42';
const REMOTE_JOB = 9_001;
const rootCause = randomUUID();
const service = randomUUID();

let app: NestFastifyApplication;
let keys: GenerateKeyPairResult;
let receiver: Server;
let receiverUrl = '';
const received: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];

async function token(): Promise<string> {
  return new SignJWT({ tenant: tenantId, preferred_username: 'runbook-operator', realm_access: { roles: [ROLES.operator, ROLES.admin] }, azp: env.KEYCLOAK_CLIENT_ID })
    .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: KID })
    .setIssuer(realmUrl(env).toString())
    .setSubject('runbooks-' + randomUUID())
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(keys.privateKey);
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<{ data?: T; errors?: Array<{ message: string }> }> {
  const res = await app.inject({ method: 'POST', url: '/graphql', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (await token()) }, payload: { query, variables } });
  return JSON.parse(res.body) as { data?: T; errors?: Array<{ message: string }> };
}

async function ok<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const r = await gql<T>(query, variables);
  if (r.errors !== undefined || r.data === undefined) throw new Error(r.errors?.map((e) => e.message).join('; ') ?? 'no data');
  return r.data;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => resolve(raw));
  });
}

const RUNBOOK_FIELDS = 'id code title estimatedMinutes steps { order instruction estimatedMinutes automation { action integration { id name } } }';
const INCIDENT_FIELDS = 'id runbook { code } suggestedRunbook { code } recoveryEstimateMinutes recoveryRemainingMinutes runbookRuns { order outcome actor remoteId error integration { id } }';
const UPSERT = 'mutation U($input: RunbookInput!) { upsertRunbook(input: $input) { ' + RUNBOOK_FIELDS + ' } }';
const RUN = 'mutation R($incidentId: UUID!, $order: Int!) { runRunbookStep(incidentId: $incidentId, order: $order) { order outcome remoteId error } }';
const INCIDENT = 'query I($id: UUID!) { incident(id: $id) { ' + INCIDENT_FIELDS + ' } }';

describe('runbooks (integration)', () => {
  beforeAll(async () => {
    receiver = createServer((req, res) => {
      void readBody(req).then((raw) => {
        received.push({ url: req.url ?? '', auth: req.headers.authorization ?? '', body: JSON.parse(raw || '{}') as Record<string, unknown> });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ job: REMOTE_JOB, status: 'pending' }));
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    receiverUrl = 'http://127.0.0.1:' + String((receiver.address() as AddressInfo).port) + '/';

    keys = await generateKeyPair(SIGNING_ALGORITHM);
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: SIGNING_ALGORITHM, use: 'sig' };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(JWKS).useValue(createLocalJWKSet({ keys: [jwk] })).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ['error', 'warn'] });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await app.get(SecretsService).write(credentialRef, { token: AWX_TOKEN });

    await prisma.organization.create({ data: { id: organizationId, name: 'Runbook org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: false } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'Runbook BU', slug: 'runbooks-' + stamp } });
  }, TIMEOUT_MS);

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    if (app !== undefined) await app.close();
    await new Promise<void>((resolve) => (receiver === undefined ? resolve() : receiver.close(() => resolve())));
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it('attaches, estimates, gates and triggers a runbook step', async () => {
    const integration = (input: Record<string, unknown>) => ok<{ upsertIntegration: { id: string } }>('mutation I($input: IntegrationInput!) { upsertIntegration(input: $input) { id } }', { input });
    const awx = (await integration({ category: 'automation', vendor: 'ansible_awx', name: 'AWX ' + stamp, endpoint: receiverUrl, credentialRef, direction: 'outbound', settings: { remoteIdPath: 'job' } })).upsertIntegration.id;
    const itsm = (await integration({ category: 'itsm', vendor: 'servicenow', name: 'SN ' + stamp, endpoint: receiverUrl, credentialRef, direction: 'outbound' })).upsertIntegration.id;

    const steps = (integrationId: string) => [
      { order: 1, instruction: 'Fail the database over to the replica', estimatedMinutes: 10, automation: { integrationId, action: JOB_TEMPLATE } },
      { order: 2, instruction: 'Confirm the application reconnects', estimatedMinutes: 5 },
    ];
    // An ITSM integration runs no playbook.
    const refused = await gql(UPSERT, { input: { code: 'RB-' + stamp, title: 'DB failover', ownerTeam: 'DBA', steps: steps(itsm) } });
    expect(refused.errors?.[0]?.message).toMatch(/itsm/);

    const runbook = (await ok<{ upsertRunbook: { id: string; estimatedMinutes: number; steps: Array<{ automation: { integration: { id: string } | null } | null }> } }>(UPSERT, { input: { code: 'RB-' + stamp, title: 'DB failover', ownerTeam: 'DBA', lastReviewedAt: '2026-11-01', steps: steps(awx) } })).upsertRunbook;
    expect(runbook.estimatedMinutes).toBe(15);
    expect(runbook.steps[0]?.automation?.integration?.id).toBe(awx);

    // A saved scenario of the root cause carries the runbook; an incident of that root cause is offered it.
    const scenario = await prisma.impactScenario.create({ data: { tenantId, name: 'DB down', kind: 'failed', failedCiIds: [rootCause], maxDepth: 0, honourRedundancy: true, includeSharedServices: true, createdBy: 'test' } });
    const attached = await ok<{ setScenarioRunbook: { runbook: { code: string } | null } }>('mutation S($s: UUID!, $r: UUID) { setScenarioRunbook(scenarioId: $s, runbookId: $r) { runbook { code } } }', { s: scenario.id, r: runbook.id });
    expect(attached.setScenarioRunbook.runbook?.code).toBe('RB-' + stamp);
    const incident = await prisma.incident.create({
      data: { tenantId, title: 'Payments down', description: 'test', severity: 'high', state: 'open', source: 'bsm', affectedServiceCiIds: [service], rootCauseCiId: rootCause, correlatedEventIds: [], openedAt: new Date() },
    });
    const offered = await ok<{ incident: { runbook: null; suggestedRunbook: { code: string } | null } }>(INCIDENT, { id: incident.id });
    expect(offered.incident.runbook).toBeNull();
    expect(offered.incident.suggestedRunbook?.code).toBe('RB-' + stamp);

    await ok('mutation A($i: UUID!, $r: UUID) { setIncidentRunbook(incidentId: $i, runbookId: $r) { id } }', { i: incident.id, r: runbook.id });
    const before = await ok<{ incident: { runbook: { code: string }; suggestedRunbook: null; recoveryEstimateMinutes: number; recoveryRemainingMinutes: number } }>(INCIDENT, { id: incident.id });
    expect(before.incident).toMatchObject({ runbook: { code: 'RB-' + stamp }, suggestedRunbook: null, recoveryEstimateMinutes: 15, recoveryRemainingMinutes: 15 });

    // The tenant has outbound integrations off by default: the run is recorded as failed, nothing is sent.
    const gated = (await ok<{ runRunbookStep: { outcome: string; error: string | null } }>(RUN, { incidentId: incident.id, order: 1 })).runRunbookStep;
    expect(gated.outcome).toBe('failed');
    expect(gated.error).toMatch(/disabled for this tenant/);
    expect(received).toHaveLength(0);

    await prisma.tenantSettings.create({ data: { tenantId, ...TENANT_SETTINGS_DEFAULTS, outboundIntegrationsEnabled: true } });
    const triggered = (await ok<{ runRunbookStep: { outcome: string; remoteId: string | null; error: string | null } }>(RUN, { incidentId: incident.id, order: 1 })).runRunbookStep;
    expect(triggered).toMatchObject({ outcome: 'triggered', remoteId: String(REMOTE_JOB), error: null });
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe('/api/v2/job_templates/' + JOB_TEMPLATE + '/launch/');
    expect(received[0]?.auth).toBe('Bearer ' + AWX_TOKEN);
    expect(received[0]?.body['extra_vars']).toMatchObject({ openmap_incident_id: incident.id, openmap_severity: 'high', openmap_runbook: 'RB-' + stamp, openmap_step: 1 });
    expect(await prisma.integrationDelivery.count({ where: { tenantId, integrationId: awx, state: 'delivered' } })).toBe(1);

    const manual = (await ok<{ runRunbookStep: { outcome: string } }>(RUN, { incidentId: incident.id, order: 2 })).runRunbookStep;
    expect(manual.outcome).toBe('done');
    const after = await ok<{ incident: { recoveryRemainingMinutes: number; runbookRuns: Array<{ order: number; outcome: string; actor: string }> } }>(INCIDENT, { id: incident.id });
    expect(after.incident.recoveryRemainingMinutes).toBe(0);
    expect(after.incident.runbookRuns.map((r) => [r.order, r.outcome])).toEqual([
      [1, 'failed'],
      [1, 'triggered'],
      [2, 'done'],
    ]);
    expect(after.incident.runbookRuns.every((r) => r.actor === 'runbook-operator')).toBe(true);
  }, TIMEOUT_MS);
});
