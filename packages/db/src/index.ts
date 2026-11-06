// REQ-CORE-009 REQ-CORE-010 — persistence layer entry point: Prisma client factory and the
// ClickHouse, Memgraph and Postgres migration runners.
import { PrismaClient } from '@prisma/client';
import { loadEnv, type Env } from '@openmap/config';

export { PrismaClient, Prisma } from '@prisma/client';
export { migrateClickHouse, CLICKHOUSE_MIGRATIONS_TABLE, type MigrationReport } from './migrate-clickhouse.js';
export { migrateMemgraph, MEMGRAPH_MIGRATION_LABEL } from './migrate-memgraph.js';
export { migratePostgres } from './migrate-postgres.js';
export { listMigrationFiles, splitStatements, substitute, CLICKHOUSE_DIR, MEMGRAPH_DIR, type MigrationFile } from './files.js';
export { IMPACT_CLOSURE_DEPTH, clickhouseParameters, memgraphParameters } from './parameters.js';
export { refreshCoveringContracts, type RawExecutor } from './asset-contracts.js';
export { fetchEndOfLifeCatalogue, loadLifecycleSnapshot, readLifecycleSnapshot, snapshotEntries, LIFECYCLE_SNAPSHOT_PATH, type LifecycleSnapshot, type FetchReport } from './lifecycle.js';

/** Query logging follows LOG_LEVEL: queries at trace/debug, otherwise warnings and errors only. */
function logLevels(env: Env): Array<'query' | 'info' | 'warn' | 'error'> {
  return env.LOG_LEVEL === 'trace' || env.LOG_LEVEL === 'debug' ? ['query', 'info', 'warn', 'error'] : ['warn', 'error'];
}

/** Creates a PrismaClient bound to POSTGRES_URL from the validated environment. */
export function createPrismaClient(env: Env = loadEnv()): PrismaClient {
  return new PrismaClient({ datasourceUrl: env.POSTGRES_URL, log: logLevels(env) });
}
