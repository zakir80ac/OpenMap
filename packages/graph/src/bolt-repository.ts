// REQ-CORE-011 — Bolt-based repository shared by Memgraph (default) and Neo4j (adapter). The two
// engines differ only in schema statements and shortest-path syntax, which the `engine` option selects.
import neo4j, { type Driver, type Record as BoltRecord, type Session } from 'neo4j-driver';
import { GRAPH } from '@openmap/constants';
import { CI_TYPES } from '@openmap/contracts';
import type {
  GraphBatchResult,
  GraphCi,
  GraphRelationship,
  GraphWriteBatch,
  GraphRepository,
  ImpactCi,
  ImpactDirection,
  ImpactNode,
  ImpactQueryOptions,
  ImpactResult,
  LayerCount,
} from './types.js';
import {
  addTypeLabelQuery,
  assertReadOnly,
  getCiQuery,
  impactQuery,
  impactQueryMemgraph,
  layerCountsQuery,
  neighboursQuery,
  relTypeFromLabel,
  retireCiQuery,
  retireCisQuery,
  retireRelationshipQuery,
  retireRelationshipsQuery,
  schemaStatementsMemgraph,
  schemaStatementsNeo4j,
  setHealthQuery,
  shortestPathQuery,
  shortestPathQueryNeo4j,
  upsertCiQuery,
  upsertRelationshipQuery,
  memgraphSchemaKey,
} from './cypher.js';

export type GraphEngine = 'memgraph' | 'neo4j';

export interface BoltRepositoryOptions {
  url: string;
  user: string;
  password: string;
  engine: GraphEngine;
  /** Neo4j database name; ignored by Memgraph. */
  database?: string;
}

interface CiRow {
  id: string;
  tenantId: string;
  type: GraphCi['type'];
  layer: GraphCi['layer'];
  name: string;
  displayName: string;
  lifecycle: string;
  health: GraphCi['health'];
  tier: number | { toNumber(): number } | null;
  validFrom: string;
  validTo: string | null;
}

interface RelRow {
  id: string;
  tenantId: string;
  type: string;
  fromCiId: string;
  toCiId: string;
  validFrom: string;
  validTo: string | null;
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (
    v &&
    typeof v === 'object' &&
    'toNumber' in v &&
    typeof (v as { toNumber: unknown }).toNumber === 'function'
  )
    return (v as { toNumber(): number }).toNumber();
  return Number(v);
}

function toCi(row: CiRow): GraphCi {
  return { ...row, tier: row.tier === null ? null : toNumber(row.tier) };
}

function toRel(row: RelRow): GraphRelationship {
  return { ...row, type: relTypeFromLabel(row.type) };
}

/**
 * Runs a schema step again while Memgraph answers with a transient error. A schema statement needs the storage to
 * itself, and even the SHOW INDEX/CONSTRAINT reads need read-only access, which another schema statement (another
 * service starting, the migrations) holds for a moment.
 */
async function retrySchema<T>(step: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (err) {
      if (!neo4j.isRetriableError(err) || attempt >= GRAPH.schemaRetryAttempts) throw err;
      await new Promise((r) => setTimeout(r, GRAPH.schemaRetryDelayMs));
    }
  }
}

export class BoltGraphRepository implements GraphRepository {
  private readonly driver: Driver;

  constructor(private readonly options: BoltRepositoryOptions) {
    this.driver = neo4j.driver(options.url, neo4j.auth.basic(options.user, options.password), {
      disableLosslessIntegers: true,
    });
  }

  private session(mode: 'READ' | 'WRITE'): Session {
    const config: { defaultAccessMode: 'READ' | 'WRITE'; database?: string } = { defaultAccessMode: mode };
    if (this.options.database !== undefined) config.database = this.options.database;
    return this.driver.session(config);
  }

  // Managed transactions: the driver retries transient errors (Memgraph's "conflicting transactions",
  // leader changes, connection resets) with backoff, so a busy graph never fails a dispatcher batch.
  private async read<T>(
    text: string,
    params: Record<string, unknown>,
    map: (r: BoltRecord) => T,
  ): Promise<T[]> {
    const s = this.session('READ');
    try {
      const records = await s.executeRead(async (tx) => (await tx.run(text, params)).records);
      return records.map(map);
    } finally {
      await s.close();
    }
  }

  private async write(text: string, params: Record<string, unknown>): Promise<number> {
    const s = this.session('WRITE');
    try {
      const first = await s.executeWrite(async (tx) => (await tx.run(text, params)).records[0]);
      return first ? toNumber(first.get('n')) : 0;
    } finally {
      await s.close();
    }
  }

  /**
   * The schema Memgraph already has, as `Label(property)` for indexes and `unique:Label(property)` for uniqueness
   * constraints. Read without the storage to itself, so a running stack (the API and the BSM engine read all the
   * time) never blocks on a statement that would change nothing.
   */
  private async existingMemgraphSchema(s: Session): Promise<Set<string>> {
    const out = new Set<string>();
    const props = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === null || v === undefined ? [] : [String(v)]);
    for (const r of (await s.run('SHOW INDEX INFO')).records) {
      for (const prop of props(r.get('property'))) out.add(String(r.get('label')) + '(' + prop + ')');
    }
    for (const r of (await s.run('SHOW CONSTRAINT INFO')).records) {
      if (String(r.get('constraint type')) !== 'unique') continue;
      for (const prop of props(r.get('properties'))) out.add('unique:' + String(r.get('label')) + '(' + prop + ')');
    }
    return out;
  }

  async ensureSchema(): Promise<void> {
    const statements =
      this.options.engine === 'neo4j' ? schemaStatementsNeo4j(CI_TYPES) : schemaStatementsMemgraph(CI_TYPES);
    const s = this.session('WRITE');
    try {
      const existing = this.options.engine === 'neo4j' ? new Set<string>() : await retrySchema(() => this.existingMemgraphSchema(s));
      for (const st of statements) {
        const key = memgraphSchemaKey(st);
        if (key !== null && existing.has(key)) continue;
        for (let attempt = 1; ; attempt++) {
          try {
            await s.run(st);
            break;
          } catch (err) {
            // Memgraph has no IF NOT EXISTS for constraints; an existing one raises and is fine.
            if (err instanceof Error && /already exists|Constraint already/i.test(err.message)) break;
            // A transient error (another query holds the storage) is retried after a pause, a bounded number of times.
            if (!neo4j.isRetriableError(err) || attempt >= GRAPH.schemaRetryAttempts) throw err;
            await new Promise((r) => setTimeout(r, GRAPH.schemaRetryDelayMs));
          }
        }
      }
    } finally {
      await s.close();
    }
  }

  async upsertCi(ci: GraphCi): Promise<void> {
    await this.upsertCis([ci]);
  }

  async upsertCis(cis: readonly GraphCi[]): Promise<number> {
    if (cis.length === 0) return 0;
    const n = await this.write(upsertCiQuery(), { rows: cis });
    const byType = new Map<string, string[]>();
    for (const ci of cis) {
      const list = byType.get(ci.type) ?? [];
      list.push(ci.id);
      byType.set(ci.type, list);
    }
    for (const [type, ids] of byType) await this.write(addTypeLabelQuery(type), { ids });
    return n;
  }

  async retireCi(tenantId: string, id: string, at: string): Promise<void> {
    await this.write(retireCiQuery(), { tenantId, id, at });
  }

  async purgeTenant(tenantId: string): Promise<number> {
    // Batched so a large tenant never holds one transaction over the whole graph.
    let total = 0;
    for (;;) {
      const n = await this.write(
        'MATCH (c:Ci {tenantId: $tenantId}) WITH c LIMIT $limit DETACH DELETE c RETURN count(*) AS n',
        { tenantId, limit: neo4j.int(GRAPH.purgeBatchSize) },
      );
      total += n;
      if (n === 0) return total;
    }
  }

  async upsertRelationship(rel: GraphRelationship): Promise<void> {
    await this.upsertRelationships([rel]);
  }

  async upsertRelationships(rels: readonly GraphRelationship[]): Promise<number> {
    const byType = new Map<GraphRelationship['type'], GraphRelationship[]>();
    for (const r of rels) {
      const list = byType.get(r.type) ?? [];
      list.push(r);
      byType.set(r.type, list);
    }
    let total = 0;
    for (const [type, rows] of byType) total += await this.write(upsertRelationshipQuery(type), { rows });
    return total;
  }

  async retireRelationship(tenantId: string, id: string, at: string): Promise<void> {
    await this.write(retireRelationshipQuery(), { tenantId, id, at });
  }

  async applyBatch(batch: GraphWriteBatch): Promise<GraphBatchResult> {
    const statements: Array<{ text: string; params: Record<string, unknown>; relationships?: readonly GraphRelationship[] }> = [];
    if (batch.cis.length > 0) {
      statements.push({ text: upsertCiQuery(), params: { rows: batch.cis } });
      const byType = new Map<string, string[]>();
      for (const ci of batch.cis) byType.set(ci.type, [...(byType.get(ci.type) ?? []), ci.id]);
      for (const [type, ids] of byType) statements.push({ text: addTypeLabelQuery(type), params: { ids } });
    }
    const relsByType = new Map<GraphRelationship['type'], GraphRelationship[]>();
    for (const r of batch.relationships) relsByType.set(r.type, [...(relsByType.get(r.type) ?? []), r]);
    for (const [type, rows] of relsByType) statements.push({ text: upsertRelationshipQuery(type), params: { rows }, relationships: rows });
    if (batch.retiredCis.length > 0) statements.push({ text: retireCisQuery(), params: { rows: batch.retiredCis } });
    if (batch.retiredRelationships.length > 0) statements.push({ text: retireRelationshipsQuery(), params: { rows: batch.retiredRelationships } });
    if (statements.length === 0) return { cis: 0, relationships: 0, unmatchedRelationshipIds: [] };
    const s = this.session('WRITE');
    try {
      // Every statement is sent before the first answer is awaited: the engine runs them in order inside the one
      // transaction, so relationships still see the CIs upserted ahead of them, and the batch pays one round trip.
      const results = await s.executeWrite((tx) => Promise.all(statements.map((st) => tx.run(st.text, st.params))));
      let relationships = 0;
      const unmatched: string[] = [];
      results.forEach((result, i) => {
        const rows = statements[i]?.relationships;
        if (rows === undefined) return;
        const written = new Set((result.records[0]?.get('ids') as string[] | undefined) ?? []);
        relationships += written.size;
        for (const r of rows) if (!written.has(r.id)) unmatched.push(r.id);
      });
      const cis = batch.cis.length > 0 ? toNumber(results[0]?.records[0]?.get('n')) : 0;
      return { cis, relationships, unmatchedRelationshipIds: unmatched };
    } finally {
      await s.close();
    }
  }

  async getCi(tenantId: string, id: string, asOf: string | null): Promise<GraphCi | null> {
    const rows = await this.read(getCiQuery(), { tenantId, id, asOf }, (r) => toCi(r.get('ci') as CiRow));
    return rows[0] ?? null;
  }

  async neighbours(
    tenantId: string,
    id: string,
    direction: ImpactDirection,
    asOf: string | null,
  ): Promise<GraphRelationship[]> {
    return this.read(
      neighboursQuery(direction),
      { tenantId, id, asOf, limit: neo4j.int(GRAPH.maxPageSize) },
      (r) => toRel(r.get('rel') as RelRow),
    );
  }

  async impact(tenantId: string, rootId: string, options: ImpactQueryOptions): Promise<ImpactResult> {
    const started = Date.now();
    // The closure and the service hops run as separate queries, side by side (REQ-PERF-002: a UNION ALL of them is planned badly).
    const q = this.options.engine === 'neo4j' ? impactQuery(tenantId, rootId, options) : impactQueryMemgraph(tenantId, rootId, options);
    const toNode = (r: BoltRecord): ImpactNode => {
      const ci = r.get('ci') as { id: string; tenantId: string; type: ImpactCi['type']; tier: number | null | undefined };
      return {
        ci: {
          id: ci.id,
          tenantId: ci.tenantId,
          type: ci.type,
          tier: ci.tier === undefined || ci.tier === null ? null : toNumber(ci.tier),
        },
        depth: toNumber(r.get('depth')),
        path: r.get('path') as string[],
      };
    };
    const rows = (await Promise.all(q.parts.map((part) => this.read(part.text, part.params, toNode)))).flat();
    // A service may come back both as a closure node and via the service hop; keep the shortest.
    const byId = new Map<string, ImpactNode>();
    for (const n of rows) {
      const prev = byId.get(n.ci.id);
      if (!prev || n.depth < prev.depth) byId.set(n.ci.id, n);
    }
    const nodes = [...byId.values()].sort(
      (a, b) =>
        a.depth - b.depth || (a.ci.tier ?? Number.MAX_SAFE_INTEGER) - (b.ci.tier ?? Number.MAX_SAFE_INTEGER),
    );
    const services = nodes.filter((n) => n.ci.type === 'business_service');
    return { rootId, nodes, services, durationMs: Date.now() - started };
  }

  async shortestPath(
    tenantId: string,
    fromId: string,
    toId: string,
    asOf: string | null,
  ): Promise<GraphRelationship[]> {
    const q =
      this.options.engine === 'neo4j'
        ? shortestPathQueryNeo4j(tenantId, fromId, toId, asOf)
        : shortestPathQuery(tenantId, fromId, toId, asOf);
    const rows = await this.read(q.text, q.params, (r) => (r.get('rels') as RelRow[]).map(toRel));
    return rows[0] ?? [];
  }

  async layerCounts(tenantId: string, asOf: string | null): Promise<LayerCount[]> {
    return this.read(layerCountsQuery(), { tenantId, asOf }, (r): LayerCount => ({
      layer: r.get('layer') as LayerCount['layer'],
      count: toNumber(r.get('count')),
      healthy: toNumber(r.get('healthy')),
      degraded: toNumber(r.get('degraded')),
      down: toNumber(r.get('down')),
    }));
  }

  async setHealth(tenantId: string, id: string, health: GraphCi['health']): Promise<void> {
    await this.write(setHealthQuery(), { tenantId, id, health });
  }

  async readOnly<T extends Record<string, unknown>>(
    cypher: string,
    params: Record<string, unknown>,
  ): Promise<T[]> {
    assertReadOnly(cypher);
    return this.read(cypher, params, (r) => r.toObject() as T);
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}
