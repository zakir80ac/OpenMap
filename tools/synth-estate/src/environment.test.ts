// T-543 REQ-DCIM-006 — the synthetic environmental history: every few hours each rack's inlet and outlet temperature
// (the outlet above the inlet), each room's humidity and each cooling unit's supply, return, humidity and capacity,
// under the collector's metric names and positions, deterministically.
import { CONTRACT_VERSIONS } from '@openmap/constants';
import { ENV_METRICS, type CollectorResult } from '@openmap/contracts';
import { describe, expect, it } from 'vitest';
import { environmentHistory } from './environment.js';

const at = '2026-11-01T00:00:00.000Z';
const ci = (type: 'rack' | 'room' | 'cooling_unit' | 'host', name: string) => ({ type, identity: { name }, name, attributes: {}, tags: [], externalIds: [], observedAt: at });
const source: CollectorResult = {
  jobId: '00000000-0000-4000-8000-000000000001',
  runId: '00000000-0000-4000-8000-000000000002',
  tenantId: '00000000-0000-4000-8000-000000000003',
  collectorId: 'dcim',
  nodeId: 'synth',
  status: 'success',
  startedAt: at,
  finishedAt: at,
  cis: [ci('rack', 'R01'), ci('room', 'DH01'), ci('cooling_unit', 'CRAC-1'), ci('host', 'srv-01')],
  relationships: [],
  samples: [],
  evidence: [],
  errors: [],
  metrics: { targetsAttempted: 1, targetsReached: 1, cisEmitted: 4, relationshipsEmitted: 0, durationMs: 0 },
  contractVersion: CONTRACT_VERSIONS.collector,
};

describe('environmentHistory', () => {
  const history = environmentHistory([source], 42, '2026-11-09T12:00:00.000Z', 1, 6);

  it('samples racks, rooms and cooling units every few hours, not other CIs', () => {
    expect(history).toHaveLength(5);
    for (const r of history) {
      const rack = r.samples.filter((s) => 'identity' in s.ci && s.ci.type === 'rack');
      const inlet = rack.find((s) => s.labels['position'] === 'inlet');
      const outlet = rack.find((s) => s.labels['position'] === 'outlet');
      expect(inlet?.metric).toBe(ENV_METRICS.temperature);
      expect(outlet?.value).toBeGreaterThan(inlet?.value ?? Infinity);
      expect(r.samples.some((s) => s.metric === ENV_METRICS.humidity && s.labels['position'] === 'room')).toBe(true);
      expect(r.samples.filter((s) => 'type' in s.ci && s.ci.type === 'cooling_unit').map((s) => s.labels['position'] ?? '')).toEqual(['supply', 'return', 'return', '']);
      expect(r.samples.some((s) => 'type' in s.ci && s.ci.type === 'host')).toBe(false);
    }
  });

  it('is deterministic for a seed', () => {
    const again = environmentHistory([source], 42, '2026-11-09T12:00:00.000Z', 1, 6);
    expect(JSON.stringify(again.map((r) => r.samples))).toBe(JSON.stringify(history.map((r) => r.samples)));
  });
});
