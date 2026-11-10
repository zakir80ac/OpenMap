// REQ-CORE-011 — Cypher builders. Pure functions so every query shape is unit-tested without an engine.
// Relationship types are validated against the contract and uppercased; nothing from a caller is
// ever interpolated except through parameters.
import { GRAPH } from '@openmap/constants';
import { RELATIONSHIP_TYPES, type RelationshipType } from '@openmap/contracts';
import type { ImpactDirection, ImpactQueryOptions } from './types.js';

export interface Query {
  text: string;
  params: Record<string, unknown>;
}

const RELATIONSHIP_SET = new Set<string>(RELATIONSHIP_TYPES);

export function relLabel(type: RelationshipType): string {
  if (!RELATIONSHIP_SET.has(type)) throw new Error('unknown relationship type ' + String(type));
  return type.toUpperCase();
}

export function relTypeFromLabel(label: string): RelationshipType {
  const lower = label.toLowerCase();
  if (!RELATIONSHIP_SET.has(lower)) throw new Error('unknown relationship label ' + label);
  return lower as RelationshipType;
}

/** Label for a CI type: `host` → `Host`, `k8s_cluster` → `K8sCluster`. */
export function typeLabel(type: string): string {
  return type
    .split('_')
    .map((p) => (p.length ? p[0]!.toUpperCase() + p.slice(1) : p))
    .join('');
}

export function clampDepth(depth: number): number {
  if (!Number.isFinite(depth) || depth <= 0) return GRAPH.defaultImpactDepth;
  return Math.min(Math.floor(depth), GRAPH.maxImpactDepth);
}

/** Temporal predicate on a node or relationship alias; `$asOf` null means current rows only. */
export function temporal(alias: string): string {
  return '(' + alias + '.validTo IS NULL OR ($asOf IS NOT NULL AND ' + alias + '.validFrom <= $asOf AND ' + alias + '.validTo > $asOf))' +
    ' AND ($asOf IS NULL OR ' + alias + '.validFrom <= $asOf)';
}

const SERVICE_EDGE: RelationshipType = 'part_of_service';
const CONTAINS_EDGE: RelationshipType = 'contains';

/**
 * Containment is a dependency only for logical containers (an application and its components), never for physical
 * ones (a switch and its interfaces), so a `contains` hop is kept only when the container's type is in the list
 * (ADR-019).
 */
function containmentFilter(types: readonly RelationshipType[]): string {
  const traversed = types.length ? types : GRAPH.impactEdgeTypes;
  if (!traversed.includes(CONTAINS_EDGE)) return '';
  return " AND ALL(r IN relationships(p) WHERE type(r) <> '" + relLabel(CONTAINS_EDGE) + "' OR startNode(r).type IN $containerTypes)";
}

/** Dependency edges to traverse; the service membership edge is applied as a final forward hop instead. */
function edgeAlternatives(types: readonly RelationshipType[]): string {
  const list = (types.length ? types : GRAPH.impactEdgeTypes).filter((t) => t !== SERVICE_EDGE);
  return list.map((t) => relLabel(t)).join('|');
}

/**
 * The impact walk's per-node projection (ImpactCi, REQ-PERF-002). `.tenantId` stays in it on purpose: without it
 * Memgraph plans the service hop forty times slower (2.7 s against 66 ms on the scale estate, measured 2026-11-08).
 */
const IMPACT_PROJECTION = '{ .id, .tenantId, .type, .tier }';

/**
 * Impact traversal. Upstream follows dependency edges against their direction (who depends on the
 * root); downstream follows with the direction (what the root depends on). Business services are
 * reached by one forward PART_OF_SERVICE hop from any node in the closure, including the root.
 * Each node and service is returned once with its shortest path.
 *
 * REQ-PERF-002: the repository runs the two halves (`parts`) as separate queries. Memgraph plans the UNION ALL of them
 * badly: on the 550k-CI scale estate the union took 2.7-3.2 s where its halves took 16-560 ms together, whatever the
 * closure size. `text` keeps the union for callers that want one statement.
 *
 * This path-enumerating form is the Neo4j adapter's; Memgraph runs `impactQueryMemgraph`.
 */
export function impactQuery(tenantId: string, rootId: string, options: ImpactQueryOptions): Query & { parts: [Query, Query] } {
  const depth = clampDepth(options.maxDepth);
  const rels = edgeAlternatives(options.edgeTypes);
  const arrow = (dir: ImpactDirection): [string, string] => (dir === 'upstream' ? ['<-', '-'] : dir === 'downstream' ? ['-', '->'] : ['-', '-']);
  const [left, right] = arrow(options.direction);
  const service = relLabel(SERVICE_EDGE);
  const containment = containmentFilter(options.edgeTypes);
  const closure =
    'MATCH (root:Ci {id: $rootId, tenantId: $tenantId})\n' +
    'MATCH p = (root)' + left + '[:' + rels + '*1..' + String(depth) + ']' + right + '(x:Ci {tenantId: $tenantId})\n' +
    'WHERE ' + temporal('x') + ' AND ALL(r IN relationships(p) WHERE ' + temporal('r') + ')' + containment + '\n' +
    'WITH x, p ORDER BY length(p) ASC\n' +
    'WITH x, head(collect(p)) AS sp\n' +
    'RETURN x ' + IMPACT_PROJECTION + ' AS ci, length(sp) AS depth, [n IN nodes(sp) | n.id] AS path';
  const services =
    'MATCH (root:Ci {id: $rootId, tenantId: $tenantId})\n' +
    'MATCH p = (root)' + left + '[:' + rels + '*0..' + String(depth) + ']' + right + '(x:Ci {tenantId: $tenantId})-[ps:' + service + ']->(s:Ci {tenantId: $tenantId})\n' +
    'WHERE ' + temporal('s') + ' AND ' + temporal('ps') + ' AND ALL(r IN relationships(p) WHERE ' + temporal('r') + ')' + containment + '\n' +
    'WITH s, p ORDER BY length(p) ASC\n' +
    'WITH s, head(collect(p)) AS sp\n' +
    'RETURN s ' + IMPACT_PROJECTION + ' AS ci, length(sp) AS depth, [n IN nodes(sp) | n.id] AS path';
  const params = { tenantId, rootId, asOf: options.asOf, containerTypes: [...GRAPH.impactContainerTypes] };
  return { text: closure + '\nUNION ALL\n' + services, params, parts: [{ text: closure, params }, { text: services, params }] };
}

/** The containment gate as a per-hop predicate on relationship `r`, for a BFS filter lambda. */
function containmentHop(types: readonly RelationshipType[]): string {
  const traversed = types.length ? types : GRAPH.impactEdgeTypes;
  if (!traversed.includes(CONTAINS_EDGE)) return '';
  return " AND (type(r) <> '" + relLabel(CONTAINS_EDGE) + "' OR startNode(r).type IN $containerTypes)";
}

/**
 * Impact traversal on Memgraph: the same closure and service hop as `impactQuery`, walked breadth first. `impactQuery`
 * enumerates every path before keeping the shortest; from a host behind a top-of-rack switch an undirected six-hop
 * walk is tens of millions of paths (26.9 M at five hops on the scale estate, a transaction timeout at six, measured
 * 2026-11-10), while BFS visits each node once (16k nodes at six hops in milliseconds). The edge filter runs inside
 * the expansion, so a pruned hop (an expired edge, a physical container's `contains`) is never expanded at all.
 *
 * The target is left unlabelled in the pattern on purpose: with `(x:Ci)` Memgraph plans a scan of every CI and a
 * point-to-point search to each (STShortestPath) instead of one single-source expansion (BFSExpand).
 */
export function impactQueryMemgraph(tenantId: string, rootId: string, options: ImpactQueryOptions): Query & { parts: Query[] } {
  const depth = clampDepth(options.maxDepth);
  const rels = edgeAlternatives(options.edgeTypes);
  const arrow = (dir: ImpactDirection): [string, string] => (dir === 'upstream' ? ['<-', '-'] : dir === 'downstream' ? ['-', '->'] : ['-', '-']);
  const [left, right] = arrow(options.direction);
  const service = relLabel(SERVICE_EDGE);
  const walk = '(root)' + left + '[:' + rels + ' *BFS ..' + String(depth) + ' (r, n | ' + temporal('r') + containmentHop(options.edgeTypes) + ')]' + right + '(x)';
  const closure =
    'MATCH (root:Ci {id: $rootId, tenantId: $tenantId})\n' +
    'MATCH p = ' + walk + '\n' +
    'WITH x, p WHERE x:Ci AND x.tenantId = $tenantId AND ' + temporal('x') + '\n' +
    'RETURN x ' + IMPACT_PROJECTION + ' AS ci, length(p) AS depth, [n IN nodes(p) | n.id] AS path';
  // The service hop from every node of the closure, and from the root itself as a third part: joined by UNION ALL the
  // two hops took 47 ms where they take 2-3 ms apiece (measured 2026-11-10), the planning that REQ-PERF-002 split the
  // halves for. Collected as paths, not as maps of path-derived lists: Memgraph 3.4.0 closes the connection on
  // `collect({..., path: [n IN nodes(p) | n.id]})`.
  const hop = ']->(s:Ci {tenantId: $tenantId})\nWHERE ' + temporal('s') + ' AND ' + temporal('ps') + '\n';
  const services =
    'MATCH (root:Ci {id: $rootId, tenantId: $tenantId})\n' +
    'MATCH p = ' + walk + '\n' +
    'WITH x, p\n' +
    'MATCH (x)-[ps:' + service + hop +
    'WITH s, p ORDER BY length(p) ASC\n' +
    'WITH s, head(collect(p)) AS sp\n' +
    'RETURN s ' + IMPACT_PROJECTION + ' AS ci, length(sp) + 1 AS depth, [n IN nodes(sp) | n.id] + [s.id] AS path';
  const rootServices =
    'MATCH (root:Ci {id: $rootId, tenantId: $tenantId})-[ps:' + service + hop +
    'RETURN s ' + IMPACT_PROJECTION + ' AS ci, 1 AS depth, [root.id, s.id] AS path';
  const params = { tenantId, rootId, asOf: options.asOf, containerTypes: [...GRAPH.impactContainerTypes] };
  const parts = [closure, services, rootServices];
  return { text: parts.join('\nUNION ALL\n'), params, parts: parts.map((text) => ({ text, params })) };
}

export function shortestPathQuery(tenantId: string, fromId: string, toId: string, asOf: string | null): Query {
  const text =
    'MATCH (a:Ci {id: $fromId, tenantId: $tenantId}), (b:Ci {id: $toId, tenantId: $tenantId})\n' +
    'MATCH p = (a)-[*BFS ..' + String(GRAPH.maxImpactDepth) + ' (r, n | ' + temporal('r') + ')]-(b)\n' +
    'RETURN [r IN relationships(p) | r { .id, .tenantId, type: type(r), fromCiId: startNode(r).id, toCiId: endNode(r).id, .validFrom, .validTo }] AS rels';
  return { text, params: { tenantId, fromId, toId, asOf } };
}

/** Neo4j has no BFS filter syntax; it uses shortestPath with a post-filter. */
export function shortestPathQueryNeo4j(tenantId: string, fromId: string, toId: string, asOf: string | null): Query {
  const text =
    'MATCH (a:Ci {id: $fromId, tenantId: $tenantId}), (b:Ci {id: $toId, tenantId: $tenantId})\n' +
    'MATCH p = shortestPath((a)-[*..' + String(GRAPH.maxImpactDepth) + ']-(b))\n' +
    'WHERE ALL(r IN relationships(p) WHERE ' + temporal('r') + ')\n' +
    'RETURN [r IN relationships(p) | r { .id, .tenantId, type: type(r), fromCiId: startNode(r).id, toCiId: endNode(r).id, .validFrom, .validTo }] AS rels';
  return { text, params: { tenantId, fromId, toId, asOf } };
}

export function upsertCiQuery(): string {
  return (
    'UNWIND $rows AS row\n' +
    'MERGE (c:Ci {id: row.id})\n' +
    'SET c += row, c.tenantId = row.tenantId\n' +
    'RETURN count(c) AS n'
  );
}

/** Adds the per-type label after the merge; Cypher cannot parameterise labels, so one statement per type. */
export function addTypeLabelQuery(type: string): string {
  return 'UNWIND $ids AS id MATCH (c:Ci {id: id}) SET c:' + typeLabel(type) + ' RETURN count(c) AS n';
}

export function retireCiQuery(): string {
  return 'MATCH (c:Ci {id: $id, tenantId: $tenantId}) WHERE c.validTo IS NULL SET c.validTo = $at RETURN count(c) AS n';
}

export function upsertRelationshipQuery(type: RelationshipType): string {
  const label = relLabel(type);
  return (
    'UNWIND $rows AS row\n' +
    'MATCH (a:Ci {id: row.fromCiId, tenantId: row.tenantId}), (b:Ci {id: row.toCiId, tenantId: row.tenantId})\n' +
    'MERGE (a)-[r:' + label + ' {id: row.id}]->(b)\n' +
    'SET r.tenantId = row.tenantId, r.validFrom = row.validFrom, r.validTo = row.validTo\n' +
    'RETURN count(r) AS n, collect(row.id) AS ids'
  );
}

/** REQ-CORE-020 — a batch of CI retirements in one statement. */
export function retireCisQuery(): string {
  return (
    'UNWIND $rows AS row\n' +
    'MATCH (c:Ci {id: row.id, tenantId: row.tenantId}) WHERE c.validTo IS NULL\n' +
    'SET c.validTo = row.at RETURN count(c) AS n'
  );
}

/** REQ-CORE-020 — a batch of relationship retirements, each found from its source CI rather than by scanning edges. */
export function retireRelationshipsQuery(): string {
  return (
    'UNWIND $rows AS row\n' +
    'MATCH (a:Ci {id: row.fromCiId, tenantId: row.tenantId})-[r]->() WHERE r.id = row.id AND r.validTo IS NULL\n' +
    'SET r.validTo = row.at RETURN count(r) AS n'
  );
}

export function retireRelationshipQuery(): string {
  return 'MATCH ()-[r {id: $id, tenantId: $tenantId}]->() WHERE r.validTo IS NULL SET r.validTo = $at RETURN count(r) AS n';
}

export function getCiQuery(): string {
  return (
    'MATCH (c:Ci {id: $id, tenantId: $tenantId}) WHERE ' + temporal('c') + '\n' +
    'RETURN c { .id, .tenantId, .type, .layer, .name, .displayName, .lifecycle, .health, .tier, .validFrom, .validTo } AS ci LIMIT 1'
  );
}

export function neighboursQuery(direction: ImpactDirection): string {
  const pattern = direction === 'upstream' ? '(c)<-[r]-(o:Ci)' : direction === 'downstream' ? '(c)-[r]->(o:Ci)' : '(c)-[r]-(o:Ci)';
  return (
    'MATCH (c:Ci {id: $id, tenantId: $tenantId})\n' +
    'MATCH ' + pattern + '\n' +
    'WHERE ' + temporal('r') + ' AND ' + temporal('o') + '\n' +
    'RETURN r { .id, .tenantId, type: type(r), fromCiId: startNode(r).id, toCiId: endNode(r).id, .validFrom, .validTo } AS rel\n' +
    'LIMIT $limit'
  );
}

export function layerCountsQuery(): string {
  return (
    'MATCH (c:Ci {tenantId: $tenantId}) WHERE ' + temporal('c') + '\n' +
    'RETURN c.layer AS layer, count(c) AS count,\n' +
    "       sum(CASE WHEN c.health = 'healthy' THEN 1 ELSE 0 END) AS healthy,\n" +
    "       sum(CASE WHEN c.health = 'degraded' THEN 1 ELSE 0 END) AS degraded,\n" +
    "       sum(CASE WHEN c.health = 'down' THEN 1 ELSE 0 END) AS down\n" +
    'ORDER BY layer'
  );
}

export function setHealthQuery(): string {
  return 'MATCH (c:Ci {id: $id, tenantId: $tenantId}) SET c.health = $health RETURN count(c) AS n';
}

const WRITE_KEYWORDS = /\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|CALL\s+\w+\.(?:create|set|delete)|LOAD\s+CSV|FOREACH)\b/i;

/** Rejects any Cypher that could write. Comments are stripped first so they cannot hide a keyword. */
export function assertReadOnly(cypher: string): void {
  const stripped = cypher.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (WRITE_KEYWORDS.test(stripped)) throw new Error('write operations are not permitted in read-only Cypher');
}

export function schemaStatementsMemgraph(ciTypes: readonly string[]): string[] {
  const out = ['CREATE CONSTRAINT ON (c:Ci) ASSERT c.id IS UNIQUE', 'CREATE INDEX ON :Ci(tenantId)', 'CREATE INDEX ON :Ci(layer)', 'CREATE INDEX ON :Ci(type)', 'CREATE INDEX ON :Ci(validTo)', 'CREATE INDEX ON :Ci(health)'];
  for (const t of ciTypes) out.push('CREATE INDEX ON :' + typeLabel(t) + '(tenantId)');
  return out;
}

export function schemaStatementsNeo4j(ciTypes: readonly string[]): string[] {
  const out = [
    'CREATE CONSTRAINT ci_id IF NOT EXISTS FOR (c:Ci) REQUIRE c.id IS UNIQUE',
    'CREATE INDEX ci_tenant IF NOT EXISTS FOR (c:Ci) ON (c.tenantId)',
    'CREATE INDEX ci_layer IF NOT EXISTS FOR (c:Ci) ON (c.layer)',
    'CREATE INDEX ci_type IF NOT EXISTS FOR (c:Ci) ON (c.type)',
    'CREATE INDEX ci_valid_to IF NOT EXISTS FOR (c:Ci) ON (c.validTo)',
    'CREATE INDEX ci_health IF NOT EXISTS FOR (c:Ci) ON (c.health)',
  ];
  for (const t of ciTypes) out.push('CREATE INDEX ci_' + t + '_tenant IF NOT EXISTS FOR (c:' + typeLabel(t) + ') ON (c.tenantId)');
  return out;
}
