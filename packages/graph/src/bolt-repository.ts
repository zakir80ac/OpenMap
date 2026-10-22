// REQ-CORE-011 — Bolt-based repository shared by Memgraph (default) and Neo4j (adapter). The two
// engines differ only in schema statements and shortest-path syntax, which the `engine` option selects.
import neo4j, { type Driver, type Record as BoltRecord, type Session } from 'neo4j-driver';
import { GRAPH } from '@openmap/constants';
import { CI_TYPES } from '@openmap/contracts';
import type { GraphCi, GraphRelationship, GraphRepository, ImpactDirection, ImpactNode, ImpactQueryOptions, ImpactResult, LayerCount } from './types.js';
import {
  addTypeLabelQuery,
  assertReadOnly,
  getCiQuery,
  impactQuery,
  layerCountsQuery,
  neighboursQuery,
  relTypeFromLabel,
  retireCiQuery,
  retireRelationshipQuery,
  schemaStatementsMemgraph,
  schemaStatementsNeo4j,
  setHealthQuery,
  shortestPathQuery,
  shortestPathQueryNeo4j,
  upsertCiQuery,
  upsertRelationshipQuery,
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
  if (v && typeof v === 'object' && 'toNumber' in v && typeof (v as { toNumber: unknown }).toNumber === 'function') return (v as { toNumber(): number }).toNumber();
  return Number(v);
}

function toCi(row: CiRow): GraphCi {
  return { ...row, tier: row.tier === null ? null : toNumber(row.tier) };
}

function toRel(row: RelRow): GraphRelationship {
  return { ...row, type: relTypeFromLabel(row.type) };
}

export class BoltGraphRepository implements GraphRepository {
  private readonly driver: Driver;

  constructor(private readonly options: BoltRepositoryOptions) {
    this.driver = neo4j.driver(options.url, neo4j.auth.basic(options.user, options.password), { disableLosslessIntegers: true });
  }

  private session(mode: 'READ' | 'WRITE'): Session {
    const config: { defaultAccessMode: 'READ' | 'WRITE'; database?: string } = { defaultAccessMode: mode };
    if (this.options.database !== undefined) config.database = this.options.database;
    return this.driver.session(config);
  }

  private async read<T>(text: string, params: Record<string, unknown>, map: (r: BoltRecord) => T): Promise<T[]> {
    const s = this.session('READ');
    try {
      const res = await s.run(text, params);
      return res.records.map(map);
    } finally {
      await s.close();
    }
  }

  private async write(text: string, params: Record<string, unknown>): Promise<number> {
    const s = this.session('WRITE');
    try {
      const res = await s.run(text, params);
      const first = res.records[0];
      return first ? toNumber(first.get('n')) : 0;
    } finally {
      await s.close();
    }
  }

  async ensureSchema(): Promise<void> {
    const statements = this.options.engine === 'neo4j' ? schemaStatementsNeo4j(CI_TYPES) : schemaStatementsMemgraph(CI_TYPES);
    const s = this.session('WRITE');
    try {
      for (const st of statements) {
        try {
          await s.run(st);
        } catch (err) {
          // Memgraph has no IF NOT EXISTS for constraints; an existing one raises and is fine.
          if (!(err instanceof Error) || !/already exists|Constraint already/i.test(err.message)) throw err;
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

  async getCi(tenantId: string, id: string, asOf: string | null): Promise<GraphCi | null> {
    const rows = await this.read(getCiQuery(), { tenantId, id, asOf }, (r) => toCi(r.get('ci') as CiRow));
    return rows[0] ?? null;
  }

  async neighbours(tenantId: string, id: string, direction: ImpactDirection, asOf: string | null): Promise<GraphRelationship[]> {
    return this.read(neighboursQuery(direction), { tenantId, id, asOf, limit: neo4j.int(GRAPH.maxPageSize) }, (r) => toRel(r.get('rel') as RelRow));
  }

  async impact(tenantId: string, rootId: string, options: ImpactQueryOptions): Promise<ImpactResult> {
    const started = Date.now();
    const q = impactQuery(tenantId, rootId, options);
    const nodes = await this.read(q.text, q.params, (r): ImpactNode => ({
      ci: toCi(r.get('ci') as CiRow),
      depth: toNumber(r.get('depth')),
      path: r.get('path') as string[],
    }));
    const services = nodes.filter((n) => n.ci.type === 'business_service');
    return { rootId, nodes, services, durationMs: Date.now() - started };
  }

  async shortestPath(tenantId: string, fromId: string, toId: string, asOf: string | null): Promise<GraphRelationship[]> {
    const q = this.options.engine === 'neo4j' ? shortestPathQueryNeo4j(tenantId, fromId, toId, asOf) : shortestPathQuery(tenantId, fromId, toId, asOf);
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

  async readOnly<T extends Record<string, unknown>>(cypher: string, params: Record<string, unknown>): Promise<T[]> {
    assertReadOnly(cypher);
    return this.read(cypher, params, (r) => r.toObject() as T);
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}
