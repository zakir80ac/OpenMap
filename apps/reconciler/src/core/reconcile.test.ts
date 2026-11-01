// T-008 REQ-CORE-013
import { describe, expect, it } from 'vitest';
import { RECONCILER } from '@openmap/constants';
import type { Ci, CollectorResult, Relationship } from '@openmap/contracts';
import { MapIdentityIndex, resolve } from './identity.js';
import { checksum, merge } from './merge.js';
import { reconcile, type StoredLookup } from './reconcile.js';

const tenantId = '9b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e';
const uuid = '1b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e';
const t0 = '2026-10-22T09:00:00.000Z';
const t1 = '2026-10-22T10:00:00.000Z';

function result(partial: Partial<CollectorResult>): CollectorResult {
  return {
    jobId: uuid, runId: uuid, tenantId, collectorId: 'snmp', nodeId: 'node-ryd-01', status: 'success', startedAt: t1, finishedAt: t1,
    cis: [], relationships: [], samples: [], evidence: [], errors: [], metrics: { targetsAttempted: 1, targetsReached: 1, cisEmitted: 0, relationshipsEmitted: 0, durationMs: 1 }, contractVersion: '0.2.0',
    ...partial,
  };
}

function lookupWith(cis: Ci[], rels: Relationship[] = []): StoredLookup {
  const index = new MapIdentityIndex();
  for (const c of cis) index.add(c, c.id);
  return { index, getCi: (id) => cis.find((c) => c.id === id), findRelationship: (type, f, t) => rels.find((r) => r.type === type && r.fromCiId === f && r.toCiId === t && r.validTo === null) };
}

const storedHost: Ci = {
  id: 'host-1', tenantId, type: 'host', layer: 'hardware', identity: { serialNumber: '7KQ2M93' }, name: 'db-ryd-pg-core-01', displayName: 'db-ryd-pg-core-01', code: 'SRV-DB-RYD-PG-CORE-01',
  attributes: { os: 'Ubuntu 22.04', memoryGb: 512 }, tags: [], externalIds: [], observedAt: t0, lifecycle: 'managed', userLabel: null,
  source: { collectorId: 'ssh_agentless', nodeId: 'node-ryd-01', runId: uuid, confidence: 0.9 }, validFrom: t0, validTo: null,
  checksum: checksum('host', { serialNumber: '7KQ2M93' }, { os: 'Ubuntu 22.04', memoryGb: 512 }),
};

describe('identity', () => {
  it('matches case-insensitively on any globally unique key and detects conflicts', () => {
    const index = new MapIdentityIndex();
    index.add({ type: 'host', identity: { serialNumber: 'ABC' } }, 'a');
    index.add({ type: 'host', identity: { fqdn: 'x.bank.local' } }, 'b');
    expect(resolve({ type: 'host', identity: { serialNumber: 'abc' } }, index)).toMatchObject({ kind: 'existing', ciId: 'a' });
    expect(resolve({ type: 'host', identity: { serialNumber: 'abc', fqdn: 'X.BANK.LOCAL' } }, index)).toMatchObject({ kind: 'conflict' });
    expect(resolve({ type: 'host', identity: { serialNumber: 'zzz' } }, index)).toEqual({ kind: 'new' });
  });
  it('matches parent-scoped keys only as a tuple', () => {
    const index = new MapIdentityIndex();
    index.add({ type: 'interface', identity: { deviceRef: 'serial:A', ifIndex: '1', name: 'Et1' } }, 'ifA1');
    index.add({ type: 'interface', identity: { deviceRef: 'serial:B', ifIndex: '1', name: 'Et1' } }, 'ifB1');
    expect(resolve({ type: 'interface', identity: { deviceRef: 'serial:A', ifIndex: '1', name: 'Et1' } }, index)).toMatchObject({ kind: 'existing', ciId: 'ifA1' });
    expect(resolve({ type: 'interface', identity: { deviceRef: 'serial:C', ifIndex: '1', name: 'Et1' } }, index)).toEqual({ kind: 'new' });
  });
});

describe('merge', () => {
  const existing = { attributes: { os: 'Ubuntu 22.04', rack: 'R12' }, source: { collectorId: 'ssh', nodeId: 'n', runId: uuid, confidence: 0.9 }, observedAt: t0 };
  it('lets a higher or equal-and-newer confidence source overwrite', () => {
    const r = merge(existing, { attributes: { os: 'Ubuntu 24.04' }, source: { ...existing.source, confidence: 0.9 }, observedAt: t1 });
    expect(r.attributes['os']).toBe('Ubuntu 24.04');
    expect(r.attributes['rack']).toBe('R12');
    expect(r.changedKeys).toEqual(['os']);
  });
  it('lets a weaker source only fill gaps', () => {
    const r = merge(existing, { attributes: { os: 'Windows', owner: 'Core banking' }, source: { ...existing.source, collectorId: 'import', confidence: 0.6 }, observedAt: t1 });
    expect(r.attributes['os']).toBe('Ubuntu 22.04');
    expect(r.attributes['owner']).toBe('Core banking');
    expect(r.source.collectorId).toBe('ssh');
  });
  it('checksum is independent of key order', () => {
    expect(checksum('host', { a: '1' }, { x: 1, y: [1, 2] })).toBe(checksum('host', { a: '1' }, { y: [1, 2], x: 1 }));
  });
});

describe('reconcile', () => {
  it('creates new CIs with derived layer and emits created events', () => {
    const out = reconcile(result({ cis: [{ type: 'network_device', identity: { serialNumber: 'FOC1' }, name: 'sw1', attributes: {}, tags: [], externalIds: [], observedAt: t1 }] }), lookupWith([]));
    expect(out.created).toHaveLength(1);
    expect(out.created[0]?.layer).toBe('network_security');
    expect(out.created[0]?.code).toBe('NET-SW1');
    expect(out.events.map((e) => e.type)).toEqual(['openmap.ci.created']);
  });
  it('updates an existing CI only when the checksum changes', () => {
    const same = reconcile(result({ cis: [{ type: 'host', identity: { serialNumber: '7kq2m93' }, name: 'db-ryd-pg-core-01', attributes: { os: 'Ubuntu 22.04' }, tags: [], externalIds: [], observedAt: t1 }] }), lookupWith([storedHost]));
    expect(same.unchanged).toBe(1);
    const changed = reconcile(result({ cis: [{ type: 'host', identity: { serialNumber: '7KQ2M93' }, name: 'db-ryd-pg-core-01', attributes: { os: 'Ubuntu 24.04' }, tags: ['prod'], externalIds: [], observedAt: t1 }] }), lookupWith([storedHost]));
    expect(changed.updated[0]?.attributes['os']).toBe('Ubuntu 24.04');
    expect(changed.updated[0]?.tags).toEqual(['prod']);
    expect(changed.events[0]?.type).toBe('openmap.ci.updated');
  });
  it('resolves relationships to new and stored CIs by identity and skips existing edges', () => {
    const out = reconcile(
      result({
        cis: [{ type: 'pdu', identity: { serialNumber: 'VG5K' }, name: 'PDU-R12-B', attributes: {}, tags: [], externalIds: [], observedAt: t1 }],
        relationships: [
          { type: 'powered_by', from: { type: 'host', identity: { serialNumber: '7KQ2M93' } }, to: { type: 'pdu', identity: { serialNumber: 'VG5K' } }, attributes: { outlet: 7 }, observedAt: t1 },
          { type: 'runs_on', from: { type: 'vm', identity: { instanceUuid: 'nope' } }, to: { id: 'host-1' }, attributes: {}, observedAt: t1 },
        ],
      }),
      lookupWith([storedHost]),
    );
    expect(out.relationshipsCreated).toHaveLength(1);
    expect(out.relationshipsCreated[0]?.fromCiId).toBe('host-1');
    expect(out.unresolvedRelationships).toHaveLength(1);
  });
  it('binds metric samples to new and stored CIs, drops unknown ones and chunks the events (REQ-CMDB-038)', () => {
    const sample = (ci: CollectorResult['samples'][number]['ci'], value: number) => ({ ci, metric: 'host.cpu.utilisation_percent', ts: t1, value, unit: 'percent', labels: { core: '0' } });
    const many = Array.from({ length: RECONCILER.samplesPerEvent + 1 }, (_, i) => sample({ type: 'host', identity: { serialNumber: '7kq2m93' } }, i));
    const out = reconcile(
      result({
        cis: [{ type: 'pdu', identity: { serialNumber: 'VG5K' }, name: 'PDU-R12-B', attributes: {}, tags: [], externalIds: [], observedAt: t1 }],
        samples: [...many, sample({ type: 'pdu', identity: { serialNumber: 'VG5K' } }, 1200), sample({ id: 'host-1' }, 7), sample({ type: 'vm', identity: { instanceUuid: 'nope' } }, 1)],
      }),
      lookupWith([storedHost]),
    );
    expect(out.samples).toBe(RECONCILER.samplesPerEvent + 3);
    expect(out.samplesDropped).toBe(1);
    const events = out.events.filter((e) => e.type === 'openmap.metric.sampled');
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.subject)).toEqual([uuid, uuid]);
    const samples = events.flatMap((e) => (e.data as { samples: Array<{ ciId: string; value: number; labels: Record<string, string> }> }).samples);
    expect(samples).toHaveLength(RECONCILER.samplesPerEvent + 3);
    expect(samples.filter((s) => s.ciId === 'host-1')).toHaveLength(RECONCILER.samplesPerEvent + 2);
    expect(samples.find((s) => s.value === 1200)?.ciId).toBe(out.created[0]?.id);
    expect(samples[0]?.labels).toEqual({ core: '0' });
    expect(samples.some((s) => 'ci' in s)).toBe(false);
  });
});
