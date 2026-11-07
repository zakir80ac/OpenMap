// T-466 REQ-BSM-004 (ADR-047) — impact prediction accuracy against the compose stack, on the tenant with the most
// replayed incidents that name a root cause. A resolved incident is raised for a component C of a business service S,
// and it also hit a service X that no modelled path from C reaches. validateImpactPrediction compares it with a
// replay simulation of C:
// - X is missed and the accuracy is the Jaccard similarity of predicted and actual;
// - the replay scenario stays out of impactScenarios;
// - a suggestion "C part_of_service X" opens.
// Accepting it creates the relationship; once the reconciler has written it to the graph, a second incident of C that
// hit X is predicted without a miss, and no second suggestion opens.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type GenerateKeyPairResult } from 'jose';
import { loadEnv } from '@openmap/config';
import { IMPACT } from '@openmap/constants';
import { compareImpact } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { createGraphRepository } from '@openmap/graph';
import { AppModule } from '../app.module.js';
import { JWKS, realmUrl } from '../auth/jwks.provider.js';
import { SIGNING_ALGORITHM } from '../auth/auth.service.js';
import { ROLES } from '../auth/roles.js';

const env = loadEnv();
const prisma = createPrismaClient(env);
const graph = createGraphRepository(env);
const KID = 'openmap-impact-validation-key';
const TIMEOUT_MS = 180_000;
const POLL_MS = 500;
const stamp = randomUUID().slice(0, 8);
const INCIDENT_MINUTES = 5;
const MS_PER_MINUTE = 60_000;

let app: NestFastifyApplication;
let keys: GenerateKeyPairResult;
let tenantId = '';
let rootId = '';
let missedId = '';
let relationshipId: string | null = null;
const incidentIds: string[] = [];

async function token(): Promise<string> {
  return new SignJWT({ tenant: tenantId, preferred_username: 'impact-tester', realm_access: { roles: [ROLES.operator] }, azp: env.KEYCLOAK_CLIENT_ID })
    .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: KID })
    .setIssuer(realmUrl(env).toString())
    .setSubject('impact-' + randomUUID())
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(keys.privateKey);
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await app.inject({ method: 'POST', url: '/graphql', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (await token()) }, payload: { query, variables } });
  const body = JSON.parse(res.body) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors !== undefined) throw new Error(body.errors.map((e) => e.message).join('; '));
  if (body.data === undefined) throw new Error('no data');
  return body.data;
}

async function until<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const v = await read();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function raiseIncident(affected: string[], title: string): Promise<string> {
  const row = await prisma.incident.create({
    data: {
      tenantId,
      title,
      description: title,
      severity: 'high',
      state: 'resolved',
      source: 'bsm',
      affectedServiceCiIds: affected,
      rootCauseCiId: rootId,
      correlatedEventIds: [],
      openedAt: new Date(Date.now() - 2 * INCIDENT_MINUTES * MS_PER_MINUTE),
      resolvedAt: new Date(Date.now() - INCIDENT_MINUTES * MS_PER_MINUTE),
    },
  });
  incidentIds.push(row.id);
  return row.id;
}

interface Validation {
  incident: { id: string };
  rootCause: { id: string } | null;
  predictedServices: Array<{ id: string }>;
  actualServices: Array<{ id: string }>;
  missedServices: Array<{ id: string }>;
  accuracy: number;
}
interface Accuracy {
  validated: number;
  meanAccuracy: number | null;
  pending: number;
  recent: Validation[];
}

const VALIDATION_FIELDS = 'incident { id } rootCause { id } predictedServices { id } actualServices { id } missedServices { id } accuracy';
const VALIDATE = 'mutation V($id: UUID!) { validateImpactPrediction(incidentId: $id) { ' + VALIDATION_FIELDS + ' } }';
const ACCURACY = 'query A($limit: Int) { impactAccuracy(limit: $limit) { validated meanAccuracy pending recent { ' + VALIDATION_FIELDS + ' } } }';
const SUGGESTIONS = 'query S($state: String) { relationshipSuggestions(state: $state) { id type from { id } to { id } occurrences state lastIncident { id } relationship { id } } }';

describe('impact prediction accuracy (integration)', () => {
  beforeAll(async () => {
    // The test runs the validation itself; no background sweep in this process.
    process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
    const populated = await prisma.incident.groupBy({ by: ['tenantId'], where: { rootCauseCiId: { not: null } }, _count: { _all: true }, orderBy: { _count: { tenantId: 'desc' } }, take: 1 });
    tenantId = populated[0]?.tenantId ?? '';
    expect(tenantId, 'a tenant with replayed incidents that name a root cause').not.toBe('');
    // A component of an application of a business service: the root cause.
    const edge = await prisma.relationship.findFirstOrThrow({ where: { tenantId, type: 'part_of_service', validTo: null }, orderBy: { id: 'asc' } });
    const closure = await graph.impact(tenantId, edge.fromCiId, { direction: 'downstream', maxDepth: 0, asOf: null, edgeTypes: [] });
    rootId = closure.nodes.find((n) => n.ci.type === 'application_component')?.ci.id ?? edge.fromCiId;
    // A business service the root cause reaches through no modelled path.
    const reached = new Set((await graph.impact(tenantId, rootId, { direction: 'upstream', maxDepth: 0, asOf: null, edgeTypes: [] })).services.map((s) => s.ci.id));
    const others = await prisma.ci.findMany({ where: { tenantId, type: 'business_service', validTo: null }, select: { id: true }, orderBy: { id: 'asc' } });
    missedId = others.find((s) => !reached.has(s.id))?.id ?? '';
    expect(missedId, 'a service the root cause does not reach').not.toBe('');

    keys = await generateKeyPair(SIGNING_ALGORITHM);
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: SIGNING_ALGORITHM, use: 'sig' };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(JWKS).useValue(createLocalJWKSet({ keys: [jwk] })).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ['error', 'warn'] });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, TIMEOUT_MS);

  afterAll(async () => {
    const replays = await prisma.impactValidation.findMany({ where: { incidentId: { in: incidentIds } }, select: { simulation: { select: { scenarioId: true, scenario: { select: { origin: true } } } } } });
    await prisma.incident.deleteMany({ where: { id: { in: incidentIds } } });
    await prisma.impactScenario.deleteMany({ where: { id: { in: replays.filter((r) => r.simulation.scenario.origin === 'incident').map((r) => r.simulation.scenarioId) } } });
    await prisma.relationshipSuggestion.deleteMany({ where: { tenantId, fromCiId: rootId, toCiId: missedId } });
    if (relationshipId !== null && app !== undefined) await gql('mutation R($id: UUID!) { retireRelationship(id: $id) { id } }', { id: relationshipId });
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it('measures a missed service, suggests the edge, and predicts it once accepted', async () => {
    const affected = (await graph.impact(tenantId, rootId, { direction: 'upstream', maxDepth: 0, asOf: null, edgeTypes: [] })).services.map((s) => s.ci.id).slice(0, 1);
    const first = await raiseIncident([...affected, missedId], 'T-466 ' + stamp + ' first');

    const v = (await gql<{ validateImpactPrediction: Validation }>(VALIDATE, { id: first })).validateImpactPrediction;
    expect(v.incident.id).toBe(first);
    expect(v.rootCause?.id).toBe(rootId);
    expect(v.actualServices.map((s) => s.id).sort()).toEqual([...affected, missedId].sort());
    expect(v.missedServices.map((s) => s.id)).toContain(missedId);
    const expected = compareImpact(v.predictedServices.map((s) => s.id), v.actualServices.map((s) => s.id));
    expect(v.accuracy).toBeCloseTo(expected.accuracy);
    expect(v.accuracy).toBeLessThan(1);

    // The replay is not a saved what-if.
    const saved = await gql<{ impactScenarios: Array<{ name: string; origin: string }> }>('query { impactScenarios { name origin } }');
    expect(saved.impactScenarios.some((s) => s.name.includes(stamp))).toBe(false);
    expect(saved.impactScenarios.every((s) => s.origin === 'user')).toBe(true);

    const open = await gql<{ relationshipSuggestions: Array<{ id: string; type: string; from: { id: string }; to: { id: string }; occurrences: number; lastIncident: { id: string } | null }> }>(SUGGESTIONS, { state: 'open' });
    const suggestion = open.relationshipSuggestions.find((s) => s.from.id === rootId && s.to.id === missedId);
    expect(suggestion).toMatchObject({ type: IMPACT.suggestionType, lastIncident: { id: first } });
    if (suggestion === undefined) return;

    const accepted = await gql<{ acceptRelationshipSuggestion: { state: string; relationship: { id: string } | null } }>('mutation A($id: UUID!) { acceptRelationshipSuggestion(id: $id) { state relationship { id } } }', { id: suggestion.id });
    expect(accepted.acceptRelationshipSuggestion.state).toBe('accepted');
    relationshipId = accepted.acceptRelationshipSuggestion.relationship?.id ?? null;
    expect(relationshipId).not.toBeNull();
    // The compose reconciler writes the edge to the graph; then the root cause reaches the service.
    await until(async () => {
      const services = (await graph.impact(tenantId, rootId, { direction: 'upstream', maxDepth: 0, asOf: null, edgeTypes: [] })).services;
      return services.some((s) => s.ci.id === missedId) ? true : null;
    });

    const second = await raiseIncident([missedId], 'T-466 ' + stamp + ' second');
    const w = (await gql<{ validateImpactPrediction: Validation }>(VALIDATE, { id: second })).validateImpactPrediction;
    expect(w.predictedServices.map((s) => s.id)).toContain(missedId);
    expect(w.missedServices).toEqual([]);
    const after = await gql<{ relationshipSuggestions: Array<{ from: { id: string }; to: { id: string } }> }>(SUGGESTIONS, { state: 'open' });
    expect(after.relationshipSuggestions.some((s) => s.from.id === rootId && s.to.id === missedId)).toBe(false);

    const accuracy = await gql<{ impactAccuracy: Accuracy }>(ACCURACY, { limit: IMPACT.recentDefault });
    expect(accuracy.impactAccuracy.validated).toBeGreaterThanOrEqual(2);
    expect(accuracy.impactAccuracy.meanAccuracy).not.toBeNull();
  }, TIMEOUT_MS);
});
