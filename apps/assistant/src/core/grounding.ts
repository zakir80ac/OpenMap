// REQ-AI-001 — schema grounding for NL→Cypher: the exact labels, relationship types, layers and
// properties the model may use, derived from the contract so the prompt can never drift from the graph.
import { CI_LAYERS, CI_TYPES, RELATIONSHIP_TYPES } from '@openmap/contracts';
import { typeLabel } from '@openmap/graph';

export const NODE_PROPERTIES = ['id', 'tenantId', 'type', 'layer', 'name', 'displayName', 'lifecycle', 'health', 'tier', 'validFrom', 'validTo'] as const;

export function schemaGrounding(): string {
  const labels = CI_TYPES.map((t) => ':Ci:' + typeLabel(t) + ' (type="' + t + '")').join(', ');
  const rels = RELATIONSHIP_TYPES.map((r) => r.toUpperCase()).join(', ');
  return [
    'Graph schema (Memgraph, Cypher):',
    'Every node has label :Ci plus one type label. Type labels: ' + labels + '.',
    'Node properties: ' + NODE_PROPERTIES.join(', ') + '. layer is one of ' + CI_LAYERS.join(', ') + '. health is one of healthy, degraded, down, unknown. tier (1 highest) exists on BusinessService only.',
    'Relationship types (direction from dependant to dependency unless named otherwise): ' + rels + '.',
    'Current rows have validTo IS NULL. Always add `WHERE n.tenantId = $tenantId` for every node variable n you return and `validTo IS NULL` unless the question asks about the past.',
    'Impact pattern: MATCH (c:Ci {name:$name})<-[:DEPENDS_ON|RUNS_ON|POWERED_BY|HOSTED_ON*1..6]-(x)-[:PART_OF_SERVICE]->(s:BusinessService).',
  ].join('\n');
}

export function systemPrompt(): string {
  return [
    'You translate questions about an IT estate into a single read-only Cypher query.',
    'Rules: output only Cypher, no prose, no code fences. Never use CREATE, MERGE, SET, DELETE, REMOVE, DROP, CALL procedures that write, or LOAD CSV.',
    'Use parameters $tenantId and $now; never inline tenant ids. Limit results with LIMIT unless the question asks for a count.',
    'Prefer returning node properties name, type, layer, health and ids rather than whole nodes.',
    schemaGrounding(),
  ].join('\n');
}
