// T-452 REQ-CORE-013 — ADR-045 in reconciliation: `*Ref` values resolve to the CI they name before tuples compare,
// SaaS tenant ids are scoped by vendor, and copies made before a ref resolved fold into one CI.
import { describe, expect, it } from 'vitest';
import type { Ci, CollectorResult, ObservedCi, Relationship } from '@openmap/contracts';
import { MapIdentityIndex, MapRefIndex, refKeyOf, resolve } from './identity.js';
import { checksum } from './merge.js';
import { reconcile, type StoredLookup } from './reconcile.js';
import { foldInto, repointRelationships } from '../worker/refs.js';

const tenantId = '9b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e';
const runId = '1b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e';
const t0 = '2026-11-07T09:00:00.000Z';
const t1 = '2026-11-07T10:00:00.000Z';

function result(collectorId: string, cis: ObservedCi[], relationships: CollectorResult['relationships'] = []): CollectorResult {
  return {
    jobId: runId, runId, tenantId, collectorId, nodeId: 'node-dmm-01', status: 'success', startedAt: t1, finishedAt: t1,
    cis, relationships, samples: [], evidence: [], errors: [], metrics: { targetsAttempted: 1, targetsReached: 1, cisEmitted: cis.length, relationshipsEmitted: 0, durationMs: 1 }, contractVersion: '0.6.0',
  };
}

function observed(type: ObservedCi['type'], identity: Record<string, string>, name: string, attributes: ObservedCi['attributes'] = {}): ObservedCi {
  return { type, identity, name, attributes, tags: [], externalIds: [], observedAt: t1 };
}

function stored(id: string, o: ObservedCi): Ci {
  return {
    ...o, id, tenantId, displayName: o.name, code: id.toUpperCase(), layer: 'compute', userLabel: null, lifecycle: 'discovered',
    source: { collectorId: 'agent', nodeId: 'node-dmm-01', runId, confidence: 0.9 }, observedAt: t0, validFrom: t0, validTo: null,
    checksum: checksum(o.type, o.identity, o.attributes),
  };
}

/** A store of CIs with their stored ref keys, as loadLookup builds it. */
function lookupWith(cis: Ci[], refKeys: Record<string, string | null> = {}): StoredLookup {
  const index = new MapIdentityIndex();
  const refs = new MapRefIndex();
  for (const c of cis) {
    index.add(c, c.id, refKeys[c.id] ?? null);
    refs.add(c, c.id);
  }
  return {
    index, refs, getCi: (id) => cis.find((c) => c.id === id), findRelationship: () => undefined,
    storedRefKey: (id) => (cis.some((c) => c.id === id) ? (refKeys[id] ?? null) : undefined),
  };
}

const vmObserved = observed('vm', { instanceUuid: 'dc7a30c3-d885-47a7-a98b-3651c29ac460', hypervisorRef: 'ahv-dmm-c01-01.bank.local', fqdn: 'api-dmm-cards-01.bank.local' }, 'api-dmm-cards-01', { ipAddress: '10.36.0.10' });
const vm = stored('vm-1', vmObserved);
const byAgent = observed('listening_service', { hostRef: 'dc7a30c3-d885-47a7-a98b-3651c29ac460', protocol: 'tcp', port: '8443' }, 'api-dmm-cards-01 tcp/8443');
const byLb = observed('listening_service', { hostRef: '10.36.0.10', protocol: 'tcp', port: '8443' }, 'api-dmm-cards-01:8443', { poolMemberState: 'up' });
const byF5 = observed('listening_service', { hostRef: 'api-dmm-cards-01.bank.local', protocol: 'tcp', port: '8443' }, 'api-dmm-cards-01.bank.local:8443');

describe('*Ref resolution (ADR-045)', () => {
  it('merges two observations of one listener that name its host differently', () => {
    const first = reconcile(result('agent', [byAgent]), lookupWith([vm]));
    expect(first.created).toHaveLength(1);
    const listener = first.created[0]!;
    const refKey = first.refKeys.get(listener.id);
    expect(refKey).toBe('listening_service|ref=@vm-1|tcp|8443');
    for (const other of [byLb, byF5]) {
      const second = reconcile(result('a10_thunder', [other]), lookupWith([vm, listener], { [listener.id]: refKey ?? null }));
      expect(second.created).toHaveLength(0);
      expect(second.conflicts).toHaveLength(0);
      expect(second.updated.map((c) => c.id).concat(second.unchanged ? [listener.id] : [])).toContain(listener.id);
    }
  });

  it('resolves a ref to a CI the same result creates, whatever order the result lists them in', () => {
    const out = reconcile(result('nutanix_ahv', [byLb, vmObserved]), lookupWith([]));
    const created = new Map(out.created.map((c) => [c.type, c]));
    const vmId = created.get('vm')?.id;
    const listenerId = created.get('listening_service')?.id ?? '';
    expect(out.refKeys.get(listenerId)).toBe('listening_service|ref=@' + String(vmId) + '|tcp|8443');
  });

  it('keeps a listener whose host no known CI names pending, and resolves its relationships by ref key', () => {
    const out = reconcile(result('haproxy', [byLb]), lookupWith([]));
    expect(out.refKeys.get(out.created[0]!.id)).toBeNull();
    const rel = { type: 'runs_on' as const, from: { type: 'listening_service' as const, identity: byLb.identity }, to: { type: 'vm' as const, identity: { fqdn: 'api-dmm-cards-01.bank.local' } }, attributes: {}, observedAt: t1 };
    const listener = stored('ls-1', byAgent);
    const viaRef = reconcile(result('a10_thunder', [], [rel]), lookupWith([vm, listener], { 'ls-1': 'listening_service|ref=@vm-1|tcp|8443' }));
    expect(viaRef.relationshipsCreated).toHaveLength(1);
    expect(viaRef.relationshipsCreated[0]).toMatchObject({ fromCiId: 'ls-1', toCiId: 'vm-1' });
  });

  it('prefers the ref key owner over a copy that only shares the raw tuple', () => {
    const index = new MapIdentityIndex();
    index.add(byLb, 'pending-copy');
    index.add(byAgent, 'resolved', 'listening_service|ref=@vm-1|tcp|8443');
    const refs = new MapRefIndex();
    refs.add(vm, 'vm-1');
    expect(resolve(byLb, index, refKeyOf(byLb, refs))).toMatchObject({ kind: 'existing', ciId: 'resolved' });
    expect(resolve(byLb, index, null)).toMatchObject({ kind: 'existing', ciId: 'pending-copy' });
  });
});

describe('issuer-scoped global keys (ADR-045)', () => {
  it('keeps the ServiceNow and Workday tenants named horizonbank apart', () => {
    const now = observed('saas_tenant', { vendor: 'ServiceNow', tenantId: 'horizonbank' }, 'horizonbank (ServiceNow)');
    const workday = observed('saas_tenant', { vendor: 'Workday', tenantId: 'horizonbank' }, 'horizonbank (Workday)');
    const out = reconcile(result('saas', [now, workday]), lookupWith([]));
    expect(out.created).toHaveLength(2);
    const again = reconcile(result('saas', [workday]), lookupWith([stored('t-now', now)]));
    expect(again.created).toHaveLength(1);
  });

  it('still merges the same tenant observed twice', () => {
    const now = observed('saas_tenant', { vendor: 'ServiceNow', tenantId: 'horizonbank' }, 'horizonbank');
    const out = reconcile(result('saas', [observed('saas_tenant', { vendor: 'servicenow', tenantId: 'HorizonBank' }, 'horizonbank')]), lookupWith([stored('t-now', now)]));
    expect(out.created).toHaveLength(0);
  });
});

describe('folding copies that share a ref key', () => {
  const survivor = stored('ls-old', byAgent);
  const copy = { ...stored('ls-new', byLb), observedAt: t1, tags: ['pool-member'] };

  it('keeps the survivor identity spelling and adds what the copy saw', () => {
    const { ci, changedKeys } = foldInto(survivor, [copy]);
    expect(ci.id).toBe('ls-old');
    expect(ci.identity['hostRef']).toBe(byAgent.identity['hostRef']);
    expect(ci.attributes['poolMemberState']).toBe('up');
    expect(ci.tags).toContain('pool-member');
    expect(ci.observedAt).toBe(t1);
    expect(changedKeys).toContain('poolMemberState');
  });

  it('re-points the copy relationships, dropping duplicates and self links', () => {
    const rel = (id: string, type: Relationship['type'], fromCiId: string, toCiId: string): Relationship => ({
      id, tenantId, type, fromCiId, toCiId, attributes: {}, source: survivor.source, observedAt: t0, validFrom: t0, validTo: null,
    });
    const rels = [
      rel('r1', 'runs_on', 'ls-old', 'vm-1'),
      rel('r2', 'runs_on', 'ls-new', 'vm-1'),
      rel('r3', 'depends_on', 'pool-1', 'ls-new'),
      rel('r4', 'depends_on', 'ls-new', 'ls-old'),
    ];
    const { retired, created } = repointRelationships(rels, new Map([['ls-new', 'ls-old']]), t1);
    expect(retired.map((r) => r.id).sort()).toEqual(['r2', 'r3', 'r4']);
    expect(retired.every((r) => r.validTo === t1)).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ type: 'depends_on', fromCiId: 'pool-1', toCiId: 'ls-old' });
  });
});
