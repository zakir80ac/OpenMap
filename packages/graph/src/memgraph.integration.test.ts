// T-007 REQ-CORE-011 — runs against the compose Memgraph (pnpm --filter @openmap/graph test:integration).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadEnv } from '@openmap/config';
import { BoltGraphRepository } from './bolt-repository.js';
import type { GraphCi, GraphRelationship } from './types.js';

const env = loadEnv();
const repo = new BoltGraphRepository({ url: env.MEMGRAPH_URL, user: env.MEMGRAPH_USER, password: env.MEMGRAPH_PASSWORD, engine: 'memgraph' });
const tenantId = randomUUID();
const now = new Date().toISOString();
/** Everything is created an hour ago so that "as of a moment before retirement" has history to read. */
const created = new Date(Date.now() - 3_600_000).toISOString();

function ci(type: GraphCi['type'], layer: GraphCi['layer'], name: string, tier: number | null = null): GraphCi {
  return { id: randomUUID(), tenantId, type, layer, name, displayName: name, lifecycle: 'managed', health: 'healthy', tier, validFrom: created, validTo: null };
}
function rel(type: GraphRelationship['type'], from: GraphCi, to: GraphCi): GraphRelationship {
  return { id: randomUUID(), tenantId, type, fromCiId: from.id, toCiId: to.id, validFrom: created, validTo: null };
}

describe('Memgraph repository', () => {
  const pdu = ci('pdu', 'dc', 'PDU-R12-B');
  const host = ci('host', 'hardware', 'db-ryd-pg-core-01');
  const db = ci('database_cluster', 'databases', 'Ledger DB');
  const app = ci('application', 'applications', 'app-ledger');
  const svc = ci('business_service', 'applications', 'Online banking', 1);
  // Containment: an application is made of its components; a switch is not made of one interface (ADR-019).
  const component = ci('application_component', 'applications', 'ledger-api');
  const toR = ci('network_device', 'network_security', 'tor-r12-a');
  const port = ci('interface', 'network_security', 'tor-r12-a Ethernet1/1');

  beforeAll(async () => {
    await repo.ensureSchema();
    await repo.upsertCis([pdu, host, db, app, svc, component, toR, port]);
    await repo.upsertRelationships([
      rel('powered_by', host, pdu),
      rel('runs_on', db, host),
      rel('depends_on', app, db),
      rel('part_of_service', app, svc),
      rel('contains', app, component),
      rel('contains', toR, port),
    ]);
  });
  afterAll(async () => {
    await repo.close();
  });

  it('finds the business service upstream of a failed PDU within the depth budget', async () => {
    const result = await repo.impact(tenantId, pdu.id, { direction: 'upstream', maxDepth: 0, asOf: null, edgeTypes: [] });
    expect(result.services.map((s) => s.ci.name)).toEqual(['Online banking']);
    expect(result.services[0]?.depth).toBe(4);
    expect(result.services[0]?.path[0]).toBe(pdu.id);
  });
  it('reaches the service from a component through its application, but not a switch from its port', async () => {
    const fromComponent = await repo.impact(tenantId, component.id, { direction: 'upstream', maxDepth: 0, asOf: null, edgeTypes: [] });
    expect(fromComponent.nodes.map((n) => n.ci.name)).toContain('app-ledger');
    expect(fromComponent.services.map((s) => s.ci.name)).toEqual(['Online banking']);
    const fromPort = await repo.impact(tenantId, port.id, { direction: 'upstream', maxDepth: 0, asOf: null, edgeTypes: [] });
    expect(fromPort.nodes.map((n) => n.ci.name)).not.toContain('tor-r12-a');
    expect(fromPort.services).toEqual([]);
  });
  it('time-travels: a retired relationship is invisible now but visible before retirement', async () => {
    const before = new Date(Date.now() - 1000).toISOString();
    const rels = await repo.neighbours(tenantId, app.id, 'downstream', null);
    const dep = rels.find((r) => r.type === 'depends_on');
    expect(dep).toBeDefined();
    await repo.retireRelationship(tenantId, dep!.id, now);
    const afterNow = await repo.impact(tenantId, db.id, { direction: 'upstream', maxDepth: 0, asOf: null, edgeTypes: [] });
    expect(afterNow.services).toHaveLength(0);
    const asOfBefore = await repo.impact(tenantId, db.id, { direction: 'upstream', maxDepth: 0, asOf: before, edgeTypes: [] });
    expect(asOfBefore.services.map((s) => s.ci.name)).toEqual(['Online banking']);
  });
  it('counts by layer and refuses write Cypher through readOnly', async () => {
    const counts = await repo.layerCounts(tenantId, null);
    // app-ledger, Online banking and the ledger-api component.
    expect(counts.find((c) => c.layer === 'applications')?.count).toBe(3);
    await expect(repo.readOnly('MATCH (n) DETACH DELETE n', {})).rejects.toThrow();
  });
});
