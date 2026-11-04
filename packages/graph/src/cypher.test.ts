// T-006 REQ-CORE-011
import { describe, expect, it } from 'vitest';
import { GRAPH } from '@openmap/constants';
import { assertReadOnly, clampDepth, impactQuery, relLabel, relTypeFromLabel, schemaStatementsMemgraph, shortestPathQuery, typeLabel, upsertRelationshipQuery } from './cypher.js';

const tenant = 't-1';

describe('cypher builders', () => {
  it('maps types and relationship labels both ways', () => {
    expect(typeLabel('k8s_cluster')).toBe('K8sCluster');
    expect(relLabel('depends_on')).toBe('DEPENDS_ON');
    expect(relTypeFromLabel('PART_OF_SERVICE')).toBe('part_of_service');
    expect(() => relLabel('owns_nothing' as 'owns')).toThrow();
  });
  it('clamps depth to the configured default and ceiling', () => {
    expect(clampDepth(0)).toBe(GRAPH.defaultImpactDepth);
    expect(clampDepth(999)).toBe(GRAPH.maxImpactDepth);
    expect(clampDepth(3)).toBe(3);
  });
  it('builds an upstream impact query over the impact edge set with temporal filters', () => {
    const q = impactQuery(tenant, 'root', { direction: 'upstream', maxDepth: 4, asOf: null, edgeTypes: [] });
    expect(q.text).toContain('(root)<-[:DEPENDS_ON|RUNS_ON');
    expect(q.text).toContain('*1..4]-(x:Ci');
    expect(q.text).toContain('validTo IS NULL');
    expect(q.text).toContain('UNION ALL');
    expect(q.text).toContain('*0..4]-(x:Ci {tenantId: $tenantId})-[ps:PART_OF_SERVICE]->(s:Ci');
    expect(q.text.split('PART_OF_SERVICE').length).toBe(2);
    // Containment is traversed, gated on the container's type (an application's components, not a switch's ports).
    expect(q.text).toContain('|CONTAINS');
    expect(q.text).toContain("type(r) <> 'CONTAINS' OR startNode(r).type IN $containerTypes");
    expect(q.params).toEqual({ tenantId: tenant, rootId: 'root', asOf: null, containerTypes: [...GRAPH.impactContainerTypes] });
  });
  it('leaves the containment gate out when the restricted edge set has no contains edge', () => {
    const q = impactQuery(tenant, 'root', { direction: 'upstream', maxDepth: 2, asOf: null, edgeTypes: ['runs_on'] });
    expect(q.text).not.toContain('$containerTypes');
  });
  it('builds a downstream query with restricted edge types', () => {
    const q = impactQuery(tenant, 'root', { direction: 'downstream', maxDepth: 2, asOf: '2026-01-01T00:00:00Z', edgeTypes: ['powered_by'] });
    expect(q.text).toContain('(root)-[:POWERED_BY*1..2]->(x:Ci');
    expect(q.params['asOf']).toBe('2026-01-01T00:00:00Z');
  });
  it('uses Memgraph BFS syntax for shortest path', () => {
    expect(shortestPathQuery(tenant, 'a', 'b', null).text).toContain('*BFS ..');
  });
  it('never interpolates relationship types that are not in the contract', () => {
    expect(() => upsertRelationshipQuery('DROP DATABASE' as 'owns')).toThrow();
  });
  it('rejects write Cypher even when hidden in comments', () => {
    expect(() => assertReadOnly('MATCH (n) RETURN n')).not.toThrow();
    expect(() => assertReadOnly('MATCH (n) DETACH DELETE n')).toThrow();
    expect(() => assertReadOnly('MATCH (n) /* set */ RETURN n')).not.toThrow();
    expect(() => assertReadOnly("MATCH (n) SET n.x = 1 RETURN n")).toThrow();
  });
  it('emits one tenant index per CI type', () => {
    const statements = schemaStatementsMemgraph(['host', 'vm']);
    expect(statements).toContain('CREATE INDEX ON :Host(tenantId)');
    expect(statements).toContain('CREATE INDEX ON :Vm(tenantId)');
  });
});
