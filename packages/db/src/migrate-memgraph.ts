// REQ-CORE-010 — applies memgraph/*.cypher in order over Bolt with neo4j-driver, recording each
// version as a (:SchemaMigration) node so a file runs once.
import neo4j, { type Driver, type Session } from 'neo4j-driver';
import { loadEnv, type Env } from '@openmap/config';
import { listMigrationFiles, loadStatements, MEMGRAPH_DIR } from './files.js';
import type { MigrationReport } from './migrate-clickhouse.js';
import { memgraphParameters } from './parameters.js';

export const MEMGRAPH_MIGRATION_LABEL = 'SchemaMigration';
const CYPHER_COMMENT = '//';
const CYPHER_EXTENSION = '.cypher';
/** Memgraph reports a repeated index, constraint or trigger with this phrase; a rerun after a partial failure treats it as done. */
const ALREADY_EXISTS = /already exists/i;

function createDriver(env: Env): Driver {
  if (env.MEMGRAPH_USER.length === 0) return neo4j.driver(env.MEMGRAPH_URL);
  return neo4j.driver(env.MEMGRAPH_URL, neo4j.auth.basic(env.MEMGRAPH_USER, env.MEMGRAPH_PASSWORD));
}

async function appliedVersions(session: Session): Promise<Set<string>> {
  const result = await session.run('MATCH (m:' + MEMGRAPH_MIGRATION_LABEL + ') RETURN m.version AS version');
  const versions = new Set<string>();
  for (const record of result.records) {
    const value: unknown = record.get('version');
    if (typeof value === 'string') versions.add(value);
  }
  return versions;
}

async function runStatement(session: Session, statement: string): Promise<void> {
  try {
    await session.run(statement);
  } catch (error) {
    if (error instanceof Error && ALREADY_EXISTS.test(error.message)) return;
    throw error;
  }
}

export async function migrateMemgraph(env: Env = loadEnv(), dir: string = MEMGRAPH_DIR): Promise<MigrationReport> {
  const driver = createDriver(env);
  const session = driver.session();
  const report: MigrationReport = { applied: [], skipped: [] };
  try {
    const applied = await appliedVersions(session);
    const params = memgraphParameters();
    for (const file of listMigrationFiles(dir, CYPHER_EXTENSION)) {
      if (applied.has(file.version)) {
        report.skipped.push(file.version);
        continue;
      }
      for (const statement of loadStatements(file, CYPHER_COMMENT, params)) {
        await runStatement(session, statement);
      }
      await session.run(
        'MERGE (m:' + MEMGRAPH_MIGRATION_LABEL + ' {version: $version}) SET m.appliedAt = $appliedAt',
        { version: file.version, appliedAt: new Date().toISOString() },
      );
      report.applied.push(file.version);
    }
  } finally {
    await session.close();
    await driver.close();
  }
  return report;
}
