// T-012 REQ-CORE-010 — ClickHouse and Memgraph files are listed in order, split cleanly, fully
// parameterised, and cover every CI type and relationship type.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '@openmap/config';
import { CI_TYPES, RELATIONSHIP_TYPES } from '@openmap/contracts';
import { CLICKHOUSE_DIR, listMigrationFiles, loadStatements, MEMGRAPH_DIR, splitStatements, substitute } from './files.js';
import { clickhouseParameters, IMPACT_CLOSURE_DEPTH, memgraphParameters } from './parameters.js';

const env = loadEnv({});
const pascal = (s: string): string => s.split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');

describe('migration file discovery', () => {
  it('lists ClickHouse files in version order starting at 0001_init', () => {
    const files = listMigrationFiles(CLICKHOUSE_DIR, '.sql');
    expect(files[0]?.version).toBe('0001_init');
    const versions = files.map((f) => f.version);
    expect(versions).toEqual([...versions].sort());
  });
  it('lists Memgraph files in version order starting at 0001_schema', () => {
    const files = listMigrationFiles(MEMGRAPH_DIR, '.cypher');
    expect(files[0]?.version).toBe('0001_schema');
    const versions = files.map((f) => f.version);
    expect(versions).toEqual([...versions].sort());
  });
});

describe('statement splitting and substitution', () => {
  it('drops comment lines and splits on a trailing semicolon', () => {
    const text = '-- header; with semicolon\nCREATE TABLE a (x Int32);\n\nSELECT 1;\n-- trailing\n';
    expect(splitStatements(text, '--')).toEqual(['CREATE TABLE a (x Int32)', 'SELECT 1']);
  });
  it('keeps multi-line statements together', () => {
    const text = 'CREATE TRIGGER t\nON --> CREATE AFTER COMMIT EXECUTE\nUNWIND x AS y\nSET y.n = 1;\nCREATE INDEX ON :A;';
    const parts = splitStatements(text, '//');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('UNWIND x AS y');
  });
  it('substitutes known tokens and rejects unknown ones', () => {
    expect(substitute('USE {database}; TTL {history_retention_days}', { database: 'd', history_retention_days: '7' })).toBe('USE d; TTL 7');
    expect(() => substitute('{nope}', {})).toThrow(/unknown substitution parameter/);
    expect(substitute('(s:BusinessService {tenantId: tenantId})', {})).toContain('{tenantId: tenantId}');
  });
});

describe('clickhouse/0001_init.sql', () => {
  const files = listMigrationFiles(CLICKHOUSE_DIR, '.sql');
  const text = readFileSync(files[0]?.path ?? '', 'utf8');
  const statements = loadStatements(files[0] ?? { version: '', path: '' }, '--', clickhouseParameters(env));

  it('carries the REQ header and only known parameters', () => {
    expect(text.startsWith('-- REQ-CORE-010')).toBe(true);
    for (const s of statements) {
      expect(s).not.toMatch(/\{[a-z_]+\}/);
      expect(s).toContain(env.CLICKHOUSE_DB + '.');
    }
  });
  it('creates every table and materialized view', () => {
    const db = env.CLICKHOUSE_DB;
    for (const t of ['ci_history', 'relationship_history', 'metrics', 'audit_log', 'events', 'discovery_runs', 'service_health_history', 'integration_deliveries']) {
      expect(statements.some((s) => s.startsWith('CREATE TABLE IF NOT EXISTS ' + db + '.' + t + '\n'))).toBe(true);
    }
    for (const v of ['layer_counts_daily', 'subnet_utilisation_daily', 'power_by_rack_hourly']) {
      expect(statements.some((s) => s.startsWith('CREATE TABLE IF NOT EXISTS ' + db + '.' + v + '\n'))).toBe(true);
      expect(statements.some((s) => s.startsWith('CREATE MATERIALIZED VIEW IF NOT EXISTS ' + db + '.' + v + '_mv\n'))).toBe(true);
    }
  });
  it('uses the engines, keys, partitioning and TTL the design requires', () => {
    const ci = statements.find((s) => s.includes('.ci_history\n')) ?? '';
    expect(ci).toContain('ENGINE = ReplacingMergeTree(recorded_at)');
    expect(ci).toContain('ORDER BY (tenant_id, ci_id, valid_from)');
    const metrics = statements.find((s) => s.includes('.metrics\n')) ?? '';
    expect(metrics).toContain('ENGINE = MergeTree');
    expect(metrics).toContain('PARTITION BY toYYYYMM(ts)');
    expect(metrics).toContain('ORDER BY (tenant_id, ci_id, metric, ts)');
    expect(metrics).toContain('TTL toDateTime(ts) + INTERVAL ' + clickhouseParameters(env)['history_retention_days'] + ' DAY');
  });
});

describe('clickhouse/0002_audit_retention.sql', () => {
  const files = listMigrationFiles(CLICKHOUSE_DIR, '.sql');
  const file = files.find((f) => f.path.endsWith('0002_audit_retention.sql'));
  const statements = loadStatements(file ?? { version: '', path: '' }, '--', clickhouseParameters(env));

  it('carries the REQ header and sets the audit_log TTL from the tenant settings default', () => {
    expect(readFileSync(file?.path ?? '', 'utf8').startsWith('-- REQ-SEC-005')).toBe(true);
    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toMatch(/\{[a-z_]+\}/);
    expect(statements[0]).toBe('ALTER TABLE ' + env.CLICKHOUSE_DB + '.audit_log MODIFY TTL toDateTime(at) + INTERVAL ' + clickhouseParameters(env)['audit_retention_days'] + ' DAY');
  });
});

describe('memgraph/0001_schema.cypher', () => {
  const files = listMigrationFiles(MEMGRAPH_DIR, '.cypher');
  const text = readFileSync(files[0]?.path ?? '', 'utf8');
  const statements = loadStatements(files[0] ?? { version: '', path: '' }, '//', memgraphParameters());

  it('carries the REQ header and only known parameters', () => {
    expect(text.startsWith('// REQ-CORE-010')).toBe(true);
    for (const s of statements) expect(s).not.toMatch(/\{[a-z_]+\}/);
  });
  it('declares the Ci constraints and indexes', () => {
    expect(statements).toContain('CREATE CONSTRAINT ON (c:Ci) ASSERT c.id IS UNIQUE');
    expect(statements).toContain('CREATE INDEX ON :Ci(tenantId, type, identityKey)');
    expect(statements).toContain('CREATE INDEX ON :Ci(layer)');
    expect(statements).toContain('CREATE INDEX ON :Ci(lifecycle)');
  });
  it('has, across the Memgraph files, a label index for every CI type and an edge index for every relationship type', () => {
    // A CI type added later (circuit, ADR-056) gets its index from a later file, so existing graphs receive it too.
    const all = files.flatMap((f) => loadStatements(f, '//', memgraphParameters()));
    for (const t of CI_TYPES) expect(all).toContain('CREATE INDEX ON :' + pascal(t));
    for (const r of RELATIONSHIP_TYPES) expect(all).toContain('CREATE EDGE INDEX ON :' + r.toUpperCase());
  });
  it('defines the impactedBy triggers with Memgraph trigger syntax and the closure depth substituted', () => {
    const triggers = statements.filter((s) => s.startsWith('CREATE TRIGGER '));
    expect(triggers.length).toBe(3);
    const create = triggers.find((s) => s.includes('_on_edge_create')) ?? '';
    expect(create).toContain('ON --> CREATE AFTER COMMIT EXECUTE');
    expect(create).toContain("'PART_OF_SERVICE'");
    expect(create).toContain("'DEPENDS_ON'");
    expect(create).toContain('*0..' + String(IMPACT_CLOSURE_DEPTH) + ']');
    expect(create).toContain('SET s.impactedBy = impacted');
    const del = triggers.find((s) => s.includes('_on_edge_delete')) ?? '';
    expect(del).toContain('ON --> DELETE AFTER COMMIT EXECUTE');
    expect(del).toContain('deletedEdges');
  });
});
