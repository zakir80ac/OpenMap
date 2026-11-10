// REQ-CORE-010 — applies clickhouse/*.sql in order through @clickhouse/client, recording each
// version in <database>.schema_migrations so a file runs once.
import { createClient } from '@clickhouse/client';
import { clickhouseOptions } from './clickhouse-options.js';
import { loadEnv, type Env } from '@openmap/config';
import { CLICKHOUSE_DIR, listMigrationFiles, loadStatements } from './files.js';
import { clickhouseParameters } from './parameters.js';

export const CLICKHOUSE_MIGRATIONS_TABLE = 'schema_migrations';
const SQL_COMMENT = '--';
const SQL_EXTENSION = '.sql';
/** ClickHouse identifiers we interpolate into DDL must be plain words; anything else is rejected. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface MigrationReport {
  applied: string[];
  skipped: string[];
}

interface VersionRow {
  version: string;
}

function assertIdentifier(name: string, what: string): void {
  if (!IDENTIFIER.test(name)) throw new Error(what + ' must match ' + String(IDENTIFIER) + ': ' + name);
}

export async function migrateClickHouse(env: Env = loadEnv(), dir: string = CLICKHOUSE_DIR): Promise<MigrationReport> {
  assertIdentifier(env.CLICKHOUSE_DB, 'CLICKHOUSE_DB');
  const database = env.CLICKHOUSE_DB;
  const table = database + '.' + CLICKHOUSE_MIGRATIONS_TABLE;
  // The database may not exist yet: the connection names none (TLS as every client, ADR-068).
  const o = clickhouseOptions(env);
  const client = createClient({ url: o.url, username: o.username, password: o.password, ...(o.tls === undefined ? {} : { tls: o.tls }) });
  const report: MigrationReport = { applied: [], skipped: [] };
  try {
    await client.command({ query: 'CREATE DATABASE IF NOT EXISTS ' + database });
    await client.command({
      query:
        'CREATE TABLE IF NOT EXISTS ' +
        table +
        ' (version String, applied_at DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree ORDER BY version',
    });
    const result = await client.query({ query: 'SELECT version FROM ' + table + ' FINAL', format: 'JSONEachRow' });
    const applied = new Set((await result.json<VersionRow>()).map((r) => r.version));
    const params = clickhouseParameters(env);
    for (const file of listMigrationFiles(dir, SQL_EXTENSION)) {
      if (applied.has(file.version)) {
        report.skipped.push(file.version);
        continue;
      }
      for (const statement of loadStatements(file, SQL_COMMENT, params)) {
        await client.command({ query: statement });
      }
      await client.insert({ table, values: [{ version: file.version }], format: 'JSONEachRow' });
      report.applied.push(file.version);
    }
  } finally {
    await client.close();
  }
  return report;
}
