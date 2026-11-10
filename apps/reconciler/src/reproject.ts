// REQ-INT-019 (ADR-066) — rebuilds the derived stores from Postgres, the system of record: every tenant's (or one
// tenant's) current CIs and relationships into Memgraph, and its CIs into Meilisearch. Run after a restore: Postgres and
// ClickHouse come back from the backup set; the graph and the search index are rebuilt rather than backed up. Health
// starts unknown and the BSM engine recomputes it on its next tick.
// Usage: node dist/reproject.js [--tenant <id>] [--keep]   (--keep adds to what is there instead of clearing first)
import { loadEnv } from '@openmap/config';
import { BACKUP } from '@openmap/constants';
import { createPrismaClient, type Prisma, type PrismaClient } from '@openmap/db';
import { createGraphRepository, type GraphRepository } from '@openmap/graph';
import { withSpan } from '@openmap/telemetry';
import {
  createMeilisearchSink,
  toGraphCi,
  toGraphRelationship,
  type SearchSink,
} from './worker/dispatcher.js';
import { rowToCi, rowToRelationship } from './worker/lookup.js';

const TRACER = 'openmap-reconciler';

export interface ReprojectReport {
  tenantId: string;
  cis: number;
  relationships: number;
  graphNodesPurged: number;
}

export interface ReprojectDeps {
  prisma: PrismaClient;
  graph: GraphRepository;
  search: SearchSink;
  batch?: number;
}

/** Rebuilds one tenant's graph and search index from its current Postgres rows. */
export async function reprojectTenant(
  deps: ReprojectDeps,
  tenantId: string,
  keep: boolean,
): Promise<ReprojectReport> {
  return withSpan(TRACER, 'reconciler.reproject', { 'openmap.tenant_id': tenantId }, async () => {
    const batch = deps.batch ?? BACKUP.reprojectBatch;
    let graphNodesPurged = 0;
    if (!keep) {
      graphNodesPurged = await deps.graph.purgeTenant(tenantId);
      await deps.search.dropTenant(tenantId);
    }
    let cis = 0;
    let cursor: string | undefined;
    for (;;) {
      const rows: Prisma.CiGetPayload<Record<string, never>>[] = await deps.prisma.ci.findMany({
        where: { tenantId, validTo: null },
        orderBy: { id: 'asc' },
        take: batch,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      });
      if (rows.length === 0) break;
      const page = rows.map(rowToCi);
      await deps.graph.upsertCis(page.map(toGraphCi));
      await deps.search.indexCis(tenantId, page);
      cis += page.length;
      cursor = rows[rows.length - 1]?.id;
      if (rows.length < batch) break;
    }
    let relationships = 0;
    cursor = undefined;
    for (;;) {
      const rows: Prisma.RelationshipGetPayload<Record<string, never>>[] =
        await deps.prisma.relationship.findMany({
          where: { tenantId, validTo: null },
          orderBy: { id: 'asc' },
          take: batch,
          ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
        });
      if (rows.length === 0) break;
      relationships += await deps.graph.upsertRelationships(
        rows.map(rowToRelationship).map(toGraphRelationship),
      );
      cursor = rows[rows.length - 1]?.id;
      if (rows.length < batch) break;
    }
    return { tenantId, cis, relationships, graphNodesPurged };
  });
}

function parseArgs(argv: readonly string[]): { tenant: string | null; keep: boolean } {
  let tenant: string | null = null;
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tenant') tenant = argv[++i] ?? null;
    if (argv[i] === '--keep') keep = true;
  }
  return { tenant, keep };
}

async function main(): Promise<void> {
  const [, , ...argv] = process.argv;
  const args = parseArgs(argv);
  const env = loadEnv();
  const prisma = createPrismaClient(env);
  const graph = createGraphRepository(env);
  await graph.ensureSchema();
  const deps: ReprojectDeps = { prisma, graph, search: createMeilisearchSink(env) };
  const tenants =
    args.tenant === null
      ? (await prisma.tenant.findMany({ select: { id: true } })).map((t) => t.id)
      : [args.tenant];
  for (const tenantId of tenants) {
    const started = Date.now();
    const report = await reprojectTenant(deps, tenantId, args.keep);
    console.log(JSON.stringify({ msg: 'reprojected', ...report, ms: Date.now() - started }));
  }
  await graph.close();
  await prisma.$disconnect();
}

if (
  process.argv[1]?.endsWith('reproject.js') === true ||
  process.argv[1]?.endsWith('reproject.ts') === true
) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
