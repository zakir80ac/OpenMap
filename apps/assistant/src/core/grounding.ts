// REQ-AI-001 — schema grounding for NL→Cypher: the exact labels, relationship types, layers and
// properties the model may use, derived from the contract so the prompt can never drift from the graph.
// The prompt shows complete worked examples instead of fragments: small models copy what they see, and a
// fragment such as `WHERE n.tenantId = ...` used to come back verbatim with `n` bound nowhere.
import { ASSISTANT, GRAPH } from '@openmap/constants';
import { CI_LAYERS, CI_TYPES, HEALTH_STATES, RELATIONSHIP_TYPES } from '@openmap/contracts';
import { typeLabel } from '@openmap/graph';

export const NODE_PROPERTIES = ['id', 'tenantId', 'type', 'layer', 'name', 'displayName', 'lifecycle', 'health', 'tier', 'validFrom', 'validTo'] as const;

export interface WorkedExample {
  question: string;
  cypher: string;
}

const SCOPE = (alias: string): string => alias + '.tenantId = $tenantId AND ' + alias + '.validTo IS NULL';
const LIMIT = 'LIMIT ' + String(ASSISTANT.maxRowsReturned);
const IMPACT_EDGES = GRAPH.impactEdgeTypes.map((r) => r.toUpperCase()).join('|');

/** Question → query pairs the prompt teaches from; every one runs against the contract graph as written. */
export function workedExamples(): WorkedExample[] {
  return [
    {
      question: 'How many hosts are there?',
      cypher: 'MATCH (h:Host) WHERE ' + SCOPE('h') + ' RETURN count(h) AS hosts',
    },
    {
      question: 'Which business services are down?',
      cypher: 'MATCH (s:BusinessService) WHERE ' + SCOPE('s') + " AND s.health = 'down' RETURN s.id AS id, s.name AS name, s.tier AS tier ORDER BY s.tier " + LIMIT,
    },
    {
      question: 'How many hosts run each operating system?',
      cypher: 'MATCH (o:OperatingSystem)-[:INSTALLED_ON]->(h:Host) WHERE ' + SCOPE('o') + ' AND ' + SCOPE('h') + ' RETURN o.name AS operatingSystem, count(h) AS hosts ORDER BY hosts DESC ' + LIMIT,
    },
    {
      question: 'Which business services depend on the host named ledger-db?',
      cypher: "MATCH (h:Host {name: 'ledger-db'})<-[:" + IMPACT_EDGES + '*1..' + String(GRAPH.defaultImpactDepth) + ']-(x)-[:PART_OF_SERVICE]->(s:BusinessService) WHERE ' + SCOPE('h') + ' AND ' + SCOPE('x') + ' AND ' + SCOPE('s') + ' RETURN DISTINCT s.id AS id, s.name AS name ' + LIMIT,
    },
    {
      question: 'Which racks hold the most hosts?',
      cypher: 'MATCH (h:Host)-[:LOCATED_IN]->(r:Rack) WHERE ' + SCOPE('h') + ' AND ' + SCOPE('r') + ' RETURN r.id AS id, r.name AS rack, count(h) AS hosts ORDER BY hosts DESC ' + LIMIT,
    },
    {
      question: 'Which software is affected by a vulnerability, and on how many hosts is it installed?',
      cypher: 'MATCH (v:Vulnerability)<-[:AFFECTED_BY]-(sw:Software)<-[:MEMBER_OF]-(i:SoftwareInstance)-[:INSTALLED_ON]->(h:Host) WHERE ' + SCOPE('v') + ' AND ' + SCOPE('sw') + ' AND ' + SCOPE('i') + ' AND ' + SCOPE('h') + ' RETURN sw.id AS id, sw.name AS software, v.name AS vulnerability, count(DISTINCT h) AS hosts ORDER BY hosts DESC ' + LIMIT,
    },
  ];
}

/**
 * Relationship directions as the reconciler writes them (dependant → dependency). The prompt lists them and
 * the validator rejects a query that traverses one of them backwards, which small models do often.
 */
export const KNOWN_DIRECTIONS: ReadonlyArray<readonly [from: string, rel: string, to: string]> = [
  ['OperatingSystem', 'INSTALLED_ON', 'Host'],
  ['Hypervisor', 'HOSTED_ON', 'Host'],
  ['ApplicationComponent', 'RUNS_ON', 'Vm'],
  ['ListeningService', 'RUNS_ON', 'Vm'],
  ['K8sWorkload', 'RUNS_ON', 'Vm'],
  ['Vm', 'RUNS_ON', 'Hypervisor'],
  ['Database', 'HOSTED_ON', 'Vm'],
  ['DatabaseCluster', 'HOSTED_ON', 'Vm'],
  ['SoftwareInstance', 'INSTALLED_ON', 'Host'],
  ['SoftwareInstance', 'INSTALLED_ON', 'Vm'],
  ['SoftwareInstance', 'MEMBER_OF', 'Software'],
  ['Hypervisor', 'MEMBER_OF', 'VmCluster'],
  ['Database', 'MEMBER_OF', 'DatabaseCluster'],
  ['FcZone', 'MEMBER_OF', 'FcFabric'],
  ['Software', 'AFFECTED_BY', 'Vulnerability'],
  ['Software', 'LICENSED_BY', 'Licence'],
  ['Application', 'PART_OF_SERVICE', 'BusinessService'],
  ['Application', 'CONTAINS', 'ApplicationComponent'],
  ['Application', 'LOCATED_IN', 'Site'],
  ['NetworkDevice', 'CONTAINS', 'Interface'],
  ['NetworkDevice', 'CONTAINS', 'Vlan'],
  ['NetworkDevice', 'CONTAINS', 'Vrf'],
  ['NetworkDevice', 'CONTAINS', 'FirewallRule'],
  ['LoadBalancer', 'CONTAINS', 'Interface'],
  ['DnsZone', 'CONTAINS', 'DnsRecord'],
  ['Subnet', 'CONTAINS', 'Subnet'],
  ['Host', 'LOCATED_IN', 'Rack'],
  ['NetworkDevice', 'LOCATED_IN', 'Rack'],
  ['NetworkDevice', 'LOCATED_IN', 'Site'],
  ['Pdu', 'LOCATED_IN', 'Rack'],
  ['Rack', 'LOCATED_IN', 'Row'],
  ['Rack', 'COOLED_BY', 'CoolingUnit'],
  ['Host', 'POWERED_BY', 'Pdu'],
  ['NetworkDevice', 'POWERED_BY', 'Pdu'],
  ['Pdu', 'POWERED_BY', 'PowerCircuit'],
  ['Host', 'USES_IP', 'IpAddress'],
  ['Vm', 'USES_IP', 'IpAddress'],
  ['Bmc', 'USES_IP', 'IpAddress'],
  ['NetworkDevice', 'USES_IP', 'IpAddress'],
  ['Interface', 'USES_IP', 'IpAddress'],
  ['IpAddress', 'IN_SUBNET', 'Subnet'],
  ['Interface', 'IN_VLAN', 'Vlan'],
  ['DnsRecord', 'RESOLVES_TO', 'IpAddress'],
  ['Host', 'CABLED_TO', 'Interface'],
  ['Interface', 'CONNECTED_TO', 'Interface'],
  ['SiteLink', 'CONNECTED_TO', 'Site'],
  ['Bmc', 'MANAGES', 'Host'],
  ['Host', 'SUPPORTED_BY', 'Vendor'],
  ['NetworkDevice', 'SUPPORTED_BY', 'Vendor'],
  ['Contract', 'SUPPORTED_BY', 'Vendor'],
  ['Host', 'COVERED_BY', 'Contract'],
  ['NetworkDevice', 'COVERED_BY', 'Contract'],
  ['Contract', 'BILLED_TO', 'CostCentre'],
  ['Host', 'ZONED_WITH', 'StorageArray'],
  ['Lun', 'PRESENTED_TO', 'Host'],
  ['Host', 'COMMUNICATES_WITH', 'ListeningService'],
  ['Vm', 'COMMUNICATES_WITH', 'ListeningService'],
  ['K8sWorkload', 'COMMUNICATES_WITH', 'ListeningService'],
  ['ApplicationComponent', 'COMMUNICATES_WITH', 'ApplicationComponent'],
];

export function schemaGrounding(): string {
  const labels = CI_TYPES.map((t) => ':Ci:' + typeLabel(t) + ' (type="' + t + '")').join(', ');
  const rels = RELATIONSHIP_TYPES.map((r) => r.toUpperCase()).join(', ');
  return [
    'Graph schema (Memgraph, Cypher):',
    'Every node has label :Ci plus one type label. Type labels: ' + labels + '.',
    'Node properties: ' + NODE_PROPERTIES.join(', ') + '. layer is one of ' + CI_LAYERS.join(', ') + '. health is exactly one of ' + HEALTH_STATES.join(', ') + ' (there is no other health value). tier (1 highest) exists on BusinessService only.',
    'Relationship types (direction from dependant to dependency unless named otherwise): ' + rels + '.',
    'Directions as stored: ' + KNOWN_DIRECTIONS.map(([from, rel, to]) => '(' + from + ')-[:' + rel + ']->(' + to + ')').join('; ') + '.',
    'Nodes carry only the properties listed above: utilisation, power draw, CPU, memory and other measurements are not in the graph, so a question about them cannot be answered here.',
    'Current rows have validTo IS NULL; add that filter unless the question asks about the past.',
  ].join('\n');
}

export function systemPrompt(): string {
  const examples = workedExamples()
    .map((e) => 'Question: ' + e.question + '\nCypher: ' + e.cypher)
    .join('\n\n');
  return [
    'You translate questions about an IT estate into a single read-only Cypher query.',
    'Rules: output only Cypher, no prose, no code fences. Never use CREATE, MERGE, SET, DELETE, REMOVE, DROP, CALL procedures that write, or LOAD CSV.',
    'The only parameters that exist are $tenantId and $now. Write every other value, such as a name, inline as a quoted literal. Never inline a tenant id.',
    'Every variable you use must be introduced in a MATCH pattern of the same query. Filter every node variable with its own tenantId = $tenantId.',
    'Finish with a RETURN clause that returns properties (id, name, type, layer, health) and aliases, not whole nodes. Limit results with LIMIT unless the question asks for a count. Aggregations such as count() belong only in WITH or RETURN.',
    schemaGrounding(),
    'Examples:',
    examples,
  ].join('\n');
}
