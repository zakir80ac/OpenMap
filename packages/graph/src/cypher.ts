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

function edgeAlternatives(types: readonly RelationshipType[]): string {
  const list = types.length ? types : GRAPH.impactEdgeTypes;
  return list.map((t) => relLabel(t)).join('|');
}

/**
 * Impact traversal. Upstream follows edges against their direction (who depends on the root);
 * downstream follows with the direction (what the root depends on). Business services are
 * collected separately with their shortest path.
 */
export function impactQuery(tenantId: string, rootId: string, options: ImpactQueryOptions): Query {
  const depth = clampDepth(options.maxDepth);
  const rels = edgeAlternatives(options.edgeTypes);
  const arrow = (dir: ImpactDirection): [string, string] => (dir === 'upstream' ? ['<-', '-'] : dir === 'downstream' ? ['-', '->'] : ['-', '-']);
  const [left, right] = arrow(options.direction);
  const text =
    'MATCH (root:Ci {id: $rootId, tenantId: $tenantId})\n' +
    'MATCH p = (root)' + left + '[:' + rels + '*1..' + String(depth) + ']' + right + '(x:Ci {tenantId: $tenantId})\n' +
    'WHERE ' + temporal('x') + ' AND ALL(r IN relationships(p) WHERE ' + temporal('r') + ')\n' +
    'WITH x, p ORDER BY length(p) ASC\n' +
    'WITH x, head(collect(p)) AS sp\n' +
    'RETURN x { .id, .tenantId, .type, .layer, .name, .displayName, .lifecycle, .health, .tier, .validFrom, .validTo } AS ci,\n' +
    '       length(sp) AS depth,\n' +
    '       [n IN nodes(sp) | n.id] AS path\n' +
    'ORDER BY depth ASC, ci.tier ASC';
  return { text, params: { tenantId, rootId, asOf: options.asOf } };
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
    'RETURN count(r) AS n'
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
