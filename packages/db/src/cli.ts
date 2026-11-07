// REQ-CORE-009 REQ-CORE-010 REQ-INT-003 REQ-CMDB-023 — migration CLI: `postgres`, `clickhouse`, `memgraph` or `all` apply
// migrations (`all` also loads the bundled lifecycle catalogue; `lifecycle` loads it alone, `lifecycle-snapshot` fetches a
// new snapshot from LIFECYCLE_CATALOGUE_URL into packages/db/lifecycle); `ping` exits 0 once Postgres accepts connections and `status` exits 0 once no Postgres migration is
// pending, so container init steps can wait on them without a shell client.
import { loadEnv } from '@openmap/config';
import { migrateClickHouse } from './migrate-clickhouse.js';
import { migrateMemgraph } from './migrate-memgraph.js';
import { migratePostgres, pendingPostgresMigrations, pingPostgres } from './migrate-postgres.js';
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { LIFECYCLE_SNAPSHOT_PATH, fetchEndOfLifeCatalogue, loadLifecycleSnapshot, readLifecycleSnapshot } from './lifecycle.js';

const TARGETS = ['postgres', 'clickhouse', 'memgraph', 'all', 'ping', 'status', 'lifecycle', 'lifecycle-snapshot'] as const;
type Target = (typeof TARGETS)[number];

function isTarget(value: string | undefined): value is Target {
  return value !== undefined && (TARGETS as readonly string[]).includes(value);
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!isTarget(target)) {
    console.error('usage: migrate <' + TARGETS.join('|') + '>');
    process.exit(2);
  }
  const env = loadEnv();
  if (target === 'ping') {
    await pingPostgres(env);
    console.log('postgres: accepting connections');
    return;
  }
  if (target === 'status') {
    const pending = await pendingPostgresMigrations(env);
    if (pending.length > 0) {
      console.error('postgres: pending migrations [' + pending.join(', ') + ']');
      process.exit(1);
    }
    console.log('postgres: schema is current');
    return;
  }
  if (target === 'lifecycle-snapshot') {
    const report = await fetchEndOfLifeCatalogue(env.LIFECYCLE_CATALOGUE_URL);
    writeFileSync(LIFECYCLE_SNAPSHOT_PATH, JSON.stringify(report.snapshot, null, 2) + '\n');
    console.log('lifecycle: snapshot of ' + String(Object.keys(report.snapshot.products).length) + ' products written to ' + LIFECYCLE_SNAPSHOT_PATH);
    for (const f of report.failed) console.error('lifecycle: ' + f.product + ' not fetched: ' + f.error);
    if (report.failed.length > 0) process.exit(1);
    return;
  }
  if (target === 'postgres' || target === 'all') {
    const r = await migratePostgres(env);
    console.log('postgres: applied [' + r.applied.join(', ') + '] skipped [' + r.skipped.join(', ') + ']' + (r.checksumMismatches.length ? ' checksum mismatches [' + r.checksumMismatches.join(', ') + ']' : '') + (r.checksumsRepaired.length ? ' line-ending checksums repaired [' + r.checksumsRepaired.join(', ') + ']' : ''));
  }
  if (target === 'clickhouse' || target === 'all') {
    const r = await migrateClickHouse(env);
    console.log('clickhouse: applied [' + r.applied.join(', ') + '] skipped [' + r.skipped.join(', ') + ']');
  }
  if (target === 'memgraph' || target === 'all') {
    const r = await migrateMemgraph(env);
    console.log('memgraph: applied [' + r.applied.join(', ') + '] skipped [' + r.skipped.join(', ') + ']');
  }
  if (target === 'lifecycle' || target === 'all') {
    const prisma = new PrismaClient({ datasources: { db: { url: env.POSTGRES_URL } } });
    try {
      const loaded = await loadLifecycleSnapshot(prisma, readLifecycleSnapshot(LIFECYCLE_SNAPSHOT_PATH));
      console.log('lifecycle: ' + String(loaded) + ' releases loaded from the bundled snapshot');
    } finally {
      await prisma.$disconnect();
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
