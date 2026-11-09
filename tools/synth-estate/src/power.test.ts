// T-537 REQ-DCIM-005 — the synthetic power history: a PDU's cords numbered onto its outlets up to its outlet count, each
// used outlet emitted as the power_feed CI the PDU contains with its device powered by it, samples every few hours for
// each outlet and the PDU (the PDU's total the outlets' sum plus its own draw), and deterministic output.
import { CONTRACT_VERSIONS } from '@openmap/constants';
import { POWER_METRICS, type CollectorResult } from '@openmap/contracts';
import { describe, expect, it } from 'vitest';
import { powerHistory } from './power.js';

const now = '2026-11-09T12:00:00.000Z';
const at = '2026-11-01T00:00:00.000Z';
const pdu = { type: 'pdu' as const, identity: { serialNumber: 'PDU-1' }, name: 'R01 PDU-A', attributes: { outlets: 2, measuredKw: 3, feed: 'A', rack: 'R01' }, tags: [], externalIds: [], observedAt: at };
const host = (n: string) => ({ type: 'host' as const, identity: { serialNumber: n } });
const source: CollectorResult = {
  jobId: '00000000-0000-4000-8000-000000000001',
  runId: '00000000-0000-4000-8000-000000000002',
  tenantId: '00000000-0000-4000-8000-000000000003',
  collectorId: 'pdu-dcim',
  nodeId: 'synth',
  status: 'success',
  startedAt: at,
  finishedAt: at,
  cis: [pdu],
  relationships: ['S1', 'S2', 'S3'].map((n) => ({ type: 'powered_by' as const, from: host(n), to: { type: 'pdu' as const, identity: pdu.identity }, attributes: { feed: 'A', psu: 1 }, observedAt: at })),
  samples: [],
  evidence: [],
  errors: [],
  metrics: { targetsAttempted: 1, targetsReached: 1, cisEmitted: 1, relationshipsEmitted: 3, durationMs: 0 },
  contractVersion: CONTRACT_VERSIONS.collector,
};

describe('powerHistory', () => {
  const history = powerHistory([source], 42, now, 1, 6);

  it('emits used outlets as power_feed CIs with their devices, up to the outlet count', () => {
    const structure = history[0];
    expect(structure?.cis.map((c) => c.identity)).toEqual([
      { pduRef: 'PDU-1', name: 'outlet-1' },
      { pduRef: 'PDU-1', name: 'outlet-2' },
    ]);
    const cords = structure?.relationships.filter((r) => r.type === 'powered_by') ?? [];
    // Three cords, two outlets: the third device gets none (an over-full PDU).
    expect(cords.map((r) => ['identity' in r.from ? r.from.identity['serialNumber'] : '', r.attributes['outlet']])).toEqual([
      ['S1', 1],
      ['S2', 2],
    ]);
    expect(structure?.relationships.filter((r) => r.type === 'contains')).toHaveLength(2);
  });

  it('samples each outlet and the PDU every few hours, the PDU total above its outlets', () => {
    const sampled = history.slice(1);
    expect(sampled).toHaveLength(5);
    for (const r of sampled) {
      const outlets = r.samples.filter((s) => s.metric === POWER_METRICS.outlet);
      const total = r.samples.find((s) => s.metric === POWER_METRICS.pdu);
      expect(outlets).toHaveLength(2);
      expect(total?.value).toBeGreaterThan(outlets.reduce((sum, s) => sum + s.value, 0));
    }
    expect(powerHistory([source], 42, now, 1, 6, false)).toHaveLength(1);
  });

  it('is deterministic for a seed', () => {
    expect(JSON.stringify(powerHistory([source], 42, now, 1, 6).map((r) => r.samples))).toBe(JSON.stringify(history.map((r) => r.samples)));
  });
});
