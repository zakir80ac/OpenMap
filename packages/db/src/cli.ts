// REQ-CORE-009 REQ-CORE-010 REQ-INT-003 — migration CLI: `postgres`, `clickhouse`, `memgraph` or `all` apply
// migrations; `ping` exits 0 once Postgres accepts connections and `status` exits 0 once no Postgres migration is
// pending, so container init steps can wait on them without a shell client.
import { loadEnv } from '@openmap/config';
import { migrateClickHouse } from './migrate-clickhouse.js';
import { migrateMemgraph } from './migrate-memgraph.js';
import { migratePostgres, pendingPostgresMigrations, pingPostgres } from './migrate-postgres.js';

const TARGETS = ['postgres', 'clickhouse', 'memgraph', 'all', 'ping', 'status'] as const;
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
