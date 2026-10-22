// REQ-CORE-009 — applies prisma/migrations in order without the Prisma CLI, so the same runner works
// in development, in the container image and in the air-gapped bundle. Bookkeeping uses Prisma's
// own `_prisma_migrations` table (same columns and SHA-256 checksums), so `prisma migrate` tooling
// stays consistent with what this runner applied.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { loadEnv, type Env } from '@openmap/config';
import { PACKAGE_ROOT } from './files.js';

export const MIGRATIONS_DIR = join(PACKAGE_ROOT, 'prisma', 'migrations');
const MIGRATION_FILE = 'migration.sql';
const BOOKKEEPING_TABLE = '_prisma_migrations';

const CREATE_BOOKKEEPING = `CREATE TABLE IF NOT EXISTS "${BOOKKEEPING_TABLE}" (
  id VARCHAR(36) PRIMARY KEY,
  checksum VARCHAR(64) NOT NULL,
  finished_at TIMESTAMPTZ,
  migration_name VARCHAR(255) NOT NULL,
  logs TEXT,
  rolled_back_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_steps_count INTEGER NOT NULL DEFAULT 0
)`;

export interface PostgresMigration {
  name: string;
  checksum: string;
  sql: string;
}

export interface PostgresMigrationReport {
  applied: string[];
  skipped: string[];
  checksumMismatches: string[];
}

/** Lists migrations on disk in lexical (timestamp/sequence) order. */
export function listPostgresMigrations(dir: string = MIGRATIONS_DIR): PostgresMigration[] {
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name, MIGRATION_FILE), 'utf8');
      return { name, checksum: createHash('sha256').update(sql).digest('hex'), sql };
    });
}

export async function migratePostgres(env: Env = loadEnv(), dir: string = MIGRATIONS_DIR): Promise<PostgresMigrationReport> {
  const client = new pg.Client({ connectionString: env.POSTGRES_URL });
  await client.connect();
  const report: PostgresMigrationReport = { applied: [], skipped: [], checksumMismatches: [] };
  try {
    await client.query(CREATE_BOOKKEEPING);
    const done = await client.query<{ migration_name: string; checksum: string }>(`SELECT migration_name, checksum FROM "${BOOKKEEPING_TABLE}" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);
    const applied = new Map(done.rows.map((r) => [r.migration_name, r.checksum]));
    for (const m of listPostgresMigrations(dir)) {
      const existing = applied.get(m.name);
      if (existing !== undefined) {
        if (existing !== m.checksum) report.checksumMismatches.push(m.name);
        report.skipped.push(m.name);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query(
          `INSERT INTO "${BOOKKEEPING_TABLE}" (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES (gen_random_uuid()::text, $1, now(), $2, now(), 1)`,
          [m.checksum, m.name],
        );
        await client.query('COMMIT');
        report.applied.push(m.name);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error('migration ' + m.name + ' failed: ' + (err instanceof Error ? err.message : String(err)));
      }
    }
  } finally {
    await client.end();
  }
  return report;
}
