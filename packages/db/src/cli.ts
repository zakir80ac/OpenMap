// REQ-CORE-009 REQ-CORE-010 — migration CLI: `postgres`, `clickhouse`, `memgraph` or `all`.
import { loadEnv } from '@openmap/config';
import { migrateClickHouse } from './migrate-clickhouse.js';
import { migrateMemgraph } from './migrate-memgraph.js';
import { migratePostgres } from './migrate-postgres.js';

const TARGETS = ['postgres', 'clickhouse', 'memgraph', 'all'] as const;
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
  if (target === 'postgres' || target === 'all') {
    const r = await migratePostgres(env);
    console.log('postgres: applied [' + r.applied.join(', ') + '] skipped [' + r.skipped.join(', ') + ']' + (r.checksumMismatches.length ? ' checksum mismatches [' + r.checksumMismatches.join(', ') + ']' : ''));
  }
  if (target === 'clickhouse' || target === 'all') {
    const r = await migrateClickHouse(env);
    console.log('clickhouse: applied [' + r.applied.join(', ') + '] skipped [' + r.skipped.join(', ') + ']');
  }
  if (target === 'memgraph' || target === 'all') {
    const r = await migrateMemgraph(env);
    console.log('memgraph: applied [' + r.applied.join(', ') + '] skipped [' + r.skipped.join(', ') + ']');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
