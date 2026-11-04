// REQ-QA-001 REQ-CORE-013 — replays a synthetic estate (or any directory of collector-result NDJSON)
// through the real pipeline and the outbox dispatcher, then reports counts, duplicates and timing.
// Usage: pnpm --filter @openmap/reconciler replay --dir ../../packages/testing/fixtures/synth-small [--no-dispatch]
import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { loadEnv } from '@openmap/config';
import { RECONCILER, TIME } from '@openmap/constants';
import { collectorResultSchema } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { createGraphRepository } from '@openmap/graph';
import { createClickHouse, createEventStream, createMeilisearchSink, dispatchOnce } from './worker/dispatcher.js';
import { processResult, retryPendingRelationships } from './worker/pipeline.js';

interface Args {
  dir: string;
  dispatch: boolean;
  reset: boolean;
}

function parseArgs(argv: string[]): Args {
  let dir = '';
  let dispatch = true;
  let reset = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') dir = argv[++i] ?? '';
    if (argv[i] === '--no-dispatch') dispatch = false;
    if (argv[i] === '--reset') reset = true;
  }
  if (!dir) throw new Error('usage: replay --dir <path> [--no-dispatch] [--reset]');
  return { dir: resolve(dir), dispatch, reset };
}

type Sinks = Parameters<typeof dispatchOnce>[1];

/** Removes everything the synthetic tenant wrote, in every store, so a replay starts from an empty estate. */
async function resetTenant(prisma: ReturnType<typeof createPrismaClient>, sinks: Sinks, database: string, tenantId: string): Promise<void> {
  // Rows that name CI ids go first: a reset recreates every CI under a new id, and an incident or scenario left
  // behind would point at an estate that no longer exists (and break the non-null Incident.service).
  await prisma.incidentLink.deleteMany({ where: { tenantId } });
  await prisma.incident.deleteMany({ where: { tenantId } });
  await prisma.impactValidation.deleteMany({ where: { tenantId } });
  await prisma.impactSimulation.deleteMany({ where: { tenantId } });
  await prisma.impactScenario.deleteMany({ where: { tenantId } });
  await prisma.pendingRelationship.deleteMany({ where: { tenantId } });
  await prisma.outboxEvent.deleteMany({ where: { tenantId } });
  await prisma.reconciliationConflict.deleteMany({ where: { tenantId } });
  await prisma.relationship.deleteMany({ where: { tenantId } });
  await prisma.ci.deleteMany({ where: { tenantId } });
  const purged = await sinks.graph.purgeTenant(tenantId);
  for (const table of ['events', 'ci_history', 'relationship_history', 'metrics', 'metrics_latest']) {
    await sinks.clickhouse.command({ query: 'ALTER TABLE ' + database + '.' + table + ' DELETE WHERE tenant_id = {tenantId:String}', query_params: { tenantId }, clickhouse_settings: { mutations_sync: '2' } });
  }
  await sinks.search.dropTenant(tenantId);
  console.log(JSON.stringify({ msg: 'reset', tenantId, graphNodesPurged: purged }));
}

async function* results(dir: string): AsyncGenerator<unknown> {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ndjson')).sort()) {
    const rl = createInterface({ input: createReadStream(join(dir, file)), crlfDelay: Infinity });
    for await (const line of rl) if (line.trim()) yield JSON.parse(line) as unknown;
  }
}

interface OrganizationFile {
  organization: { id: string; name: string; industry: string; timeZone: string; defaultLocale: 'en' | 'ar'; regulatoryScope: string[]; businessUnits: Array<{ tenantId: string; name: string }> };
}

/** Creates the synthetic organization and the tenant the results belong to, if they do not exist yet. */
async function ensureTenant(prisma: ReturnType<typeof createPrismaClient>, dir: string): Promise<void> {
  const org = (JSON.parse(readFileSync(join(dir, 'organization.json'), 'utf8')) as OrganizationFile).organization;
  const summary = JSON.parse(readFileSync(join(dir, 'estate-summary.json'), 'utf8')) as { tenantId: string };
  await prisma.organization.upsert({
    where: { id: org.id },
    update: {},
    create: { id: org.id, name: org.name, industry: org.industry, timeZone: org.timeZone, defaultLocale: org.defaultLocale, regulatoryScope: org.regulatoryScope, airGapped: false },
  });
  const unit = org.businessUnits.find((b) => b.tenantId === summary.tenantId);
  await prisma.tenant.upsert({
    where: { id: summary.tenantId },
    update: {},
    create: { id: summary.tenantId, organizationId: org.id, name: unit?.name ?? org.name, slug: 'synth-' + summary.tenantId.split('-')[0] },
  });
}

async function main(): Promise<void> {
  const [, , ...argv] = process.argv;
  const args = parseArgs(argv);
  const env = loadEnv();
  const prisma = createPrismaClient(env);
  await ensureTenant(prisma, args.dir);
  const summaryTenant = (JSON.parse(readFileSync(join(args.dir, 'estate-summary.json'), 'utf8')) as { tenantId: string }).tenantId;
  const graph = createGraphRepository(env);
  await graph.ensureSchema();
  const sinks: Sinks = { graph, clickhouse: createClickHouse(env), search: createMeilisearchSink(env), stream: createEventStream(env) };
  if (args.reset) await resetTenant(prisma, sinks, env.CLICKHOUSE_DB, summaryTenant);
  const started = Date.now();
  let n = 0;
  const totals = { created: 0, updated: 0, unchanged: 0, relationships: 0, conflicts: 0, unresolved: 0, samples: 0, samplesDropped: 0, lookupMs: 0, reconcileMs: 0, reconcileCpuMs: 0, persistMs: 0 };
  let tenantId = '';
  for await (const raw of results(args.dir)) {
    const result = collectorResultSchema.parse(raw);
    tenantId = result.tenantId;
    const s = await processResult(prisma, result);
    totals.created += s.created;
    totals.updated += s.updated;
    totals.unchanged += s.unchanged;
    totals.relationships += s.relationships;
    totals.conflicts += s.conflicts;
    totals.unresolved += s.unresolvedRelationships;
    totals.samples += s.samples;
    totals.samplesDropped += s.samplesDropped;
    totals.lookupMs += s.lookupMs;
    totals.reconcileMs += s.reconcileMs;
    totals.persistMs += s.persistMs;
    totals.reconcileCpuMs += Math.round(s.reconcileCpuMs);
    n++;
    console.log(JSON.stringify({ msg: 'result', collectorId: result.collectorId, cis: result.cis.length, relationships: result.relationships.length, created: s.created, lookupMs: s.lookupMs, reconcileMs: s.reconcileMs, reconcileCpuMs: Math.round(s.reconcileCpuMs), persistMs: s.persistMs, unresolved: s.unresolvedRelationships }));
    if (n % RECONCILER.replayProgressEvery === 0) console.log(JSON.stringify({ msg: 'progress', results: n, ...totals, seconds: Math.round((Date.now() - started) / TIME.msPerSecond) }));
  }
  let pendingResolved = 0;
  const pendingStart = Date.now();
  for (;;) {
    const r = await retryPendingRelationships(prisma, tenantId);
    pendingResolved += r.resolved;
    if (r.tried === 0 || r.resolved === 0) break;
  }
  const pendingMs = Date.now() - pendingStart;
  const pendingLeft = await prisma.pendingRelationship.count({ where: { tenantId } });
  const phaseMs = Date.now() - started;
  const dupes = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM (SELECT "tenantId", type, "identityKey" FROM cis WHERE "validTo" IS NULL GROUP BY 1,2,3 HAVING count(*) > 1) d`;
  const ciCount = await prisma.ci.count({ where: { tenantId, validTo: null } });
  const relCount = await prisma.relationship.count({ where: { tenantId, validTo: null } });
  console.log(JSON.stringify({ msg: 'reconciled', results: n, ...totals, pendingResolved, pendingLeft, cisInStore: ciCount, relationshipsInStore: relCount, duplicateIdentities: Number(dupes[0]?.n ?? 0n), pendingMs, phaseMs, cisPerSecond: Math.round((ciCount / phaseMs) * TIME.msPerSecond) }));

  if (args.dispatch) {
    const dispatchStart = Date.now();
    let delivered = 0;
    for (;;) {
      const r = await dispatchOnce(prisma, sinks, env.CLICKHOUSE_DB);
      if (r.failures.length) console.error(JSON.stringify({ msg: 'outbox failures', failures: r.failures }));
      delivered += r.delivered;
      if (r.claimed === 0 || (r.failures.length > 0 && r.delivered === 0)) break;
    }
    const layers = await graph.layerCounts(tenantId, null);
    console.log(JSON.stringify({ msg: 'dispatched', delivered, dispatchMs: Date.now() - dispatchStart, graphLayers: layers }));
  }
  await sinks.stream.close();
  await sinks.clickhouse.close();
  await graph.close();
  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
