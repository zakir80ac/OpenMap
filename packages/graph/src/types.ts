// REQ-CORE-011 — graph repository interface. Memgraph is the default engine, Neo4j the adapter;
// callers never write Cypher themselves.
import type { CiLayer, CiType, RelationshipType } from '@openmap/contracts';

export type ImpactDirection = 'upstream' | 'downstream' | 'both';

export interface GraphCi {
  id: string;
  tenantId: string;
  type: CiType;
  layer: CiLayer;
  name: string;
  displayName: string;
  lifecycle: string;
  /** Health as last propagated by the BSM engine; stored on the node for fast impact reads. */
  health: 'healthy' | 'degraded' | 'down' | 'unknown';
  /** Service tier for business services; null for everything else. */
  tier: number | null;
  validFrom: string;
  validTo: string | null;
}

export interface GraphRelationship {
  id: string;
  tenantId: string;
  type: RelationshipType;
  fromCiId: string;
  toCiId: string;
  validFrom: string;
  validTo: string | null;
}

/**
 * REQ-PERF-002 — what an impact walk carries per node: enough to tell services and applications apart and to order by
 * tier. A closure can hold tens of thousands of nodes, and the full projection cost twice as much under load; callers
 * that need the whole CI load it by id.
 */
export type ImpactCi = Pick<GraphCi, 'id' | 'tenantId' | 'type' | 'tier'>;

export interface ImpactNode {
  ci: ImpactCi;
  depth: number;
  /** Ids from the root to this node, root first. */
  path: string[];
}

export interface ImpactQueryOptions {
  direction: ImpactDirection;
  /** 0 means the configured default depth; values above the ceiling are clamped. */
  maxDepth: number;
  /** ISO datetime for time-travel reads; null means now. */
  asOf: string | null;
  /** Restrict traversal to these relationship types; empty means the impact edge set. */
  edgeTypes: readonly RelationshipType[];
}

export interface ImpactResult {
  rootId: string;
  nodes: ImpactNode[];
  /** Business services reached, with the shortest path to each. */
  services: ImpactNode[];
  durationMs: number;
}

export interface LayerCount {
  layer: CiLayer;
  count: number;
  healthy: number;
  degraded: number;
  down: number;
}

export interface GraphRepository {
  /** Applies constraints and indexes; idempotent. */
  ensureSchema(): Promise<void>;
  upsertCi(ci: GraphCi): Promise<void>;
  upsertCis(cis: readonly GraphCi[]): Promise<number>;
  retireCi(tenantId: string, id: string, at: string): Promise<void>;
  upsertRelationship(rel: GraphRelationship): Promise<void>;
  upsertRelationships(rels: readonly GraphRelationship[]): Promise<number>;
  retireRelationship(tenantId: string, id: string, at: string): Promise<void>;
  getCi(tenantId: string, id: string, asOf: string | null): Promise<GraphCi | null>;
  neighbours(tenantId: string, id: string, direction: ImpactDirection, asOf: string | null): Promise<GraphRelationship[]>;
  impact(tenantId: string, rootId: string, options: ImpactQueryOptions): Promise<ImpactResult>;
  shortestPath(tenantId: string, fromId: string, toId: string, asOf: string | null): Promise<GraphRelationship[]>;
  layerCounts(tenantId: string, asOf: string | null): Promise<LayerCount[]>;
  setHealth(tenantId: string, id: string, health: GraphCi['health']): Promise<void>;
  /** Deletes every node and edge of a tenant (tenant off-boarding, test and replay resets). Returns nodes removed. */
  purgeTenant(tenantId: string): Promise<number>;
  /** Read-only Cypher for the assistant; writes are rejected before reaching the engine. */
  readOnly<T extends Record<string, unknown>>(cypher: string, params: Record<string, unknown>): Promise<T[]>;
  close(): Promise<void>;
}
