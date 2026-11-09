// T-528 REQ-DCIM-004 (ADR-058) — the power contract: circuit capacity from amps, volts and phases; devices on one PDU or
// one feed; a redundant pair (PDUs of a rack, circuits or UPS units of a room) whose survivor could not carry both loads;
// a UPS with short battery runtime; a PDU with more cords than outlets; and nothing judged without a rating or reading.
import { POWER } from '@openmap/constants';
import { describe, expect, it } from 'vitest';
import { assessPower, circuitRatedWatts, type PowerCord, type PowerSourceNode } from './power.js';

function source(id: string, kind: PowerSourceNode['kind'], o: Partial<PowerSourceNode> = {}): PowerSourceNode {
  return { id, kind, feed: null, ratedWatts: null, loadWatts: null, group: null, outlets: null, runtimeMinutes: null, ...o };
}

describe('power contract', () => {
  it('rates a circuit by its phases', () => {
    expect(circuitRatedWatts(32, 230, 1)).toBe(7_360);
    expect(circuitRatedWatts(400, 400, POWER.threePhase)).toBe(Math.round(400 * 400 * Math.sqrt(3)));
  });

  it('finds single-corded devices and devices with every cord on one feed', () => {
    const cords: PowerCord[] = [
      { deviceId: 'srv-ok', pduId: 'pdu-a', feed: 'A' },
      { deviceId: 'srv-ok', pduId: 'pdu-b', feed: 'B' },
      { deviceId: 'srv-single', pduId: 'pdu-a', feed: 'A' },
      { deviceId: 'srv-same', pduId: 'pdu-a', feed: 'A' },
      { deviceId: 'srv-same', pduId: 'pdu-a2', feed: 'A' },
    ];
    const findings = assessPower([], cords);
    expect(findings.map((f) => [f.kind, f.ciId])).toEqual([
      ['single_corded', 'srv-single'],
      ['same_feed', 'srv-same'],
    ]);
  });

  it('flags the survivor of a pair that could not carry both loads, and judges nothing unmeasured', () => {
    const sources = [
      source('pdu-a', 'pdu', { feed: 'A', group: 'rack-1', ratedWatts: 7_000, loadWatts: 4_000 }),
      source('pdu-b', 'pdu', { feed: 'B', group: 'rack-1', ratedWatts: 10_000, loadWatts: 4_000 }),
      source('ups-a', 'ups', { feed: 'A', group: 'room-1', ratedWatts: 100_000, loadWatts: 40_000, runtimeMinutes: POWER.minUpsRuntimeMinutes - 1 }),
      source('ups-b', 'ups', { feed: 'B', group: 'room-1', ratedWatts: 100_000, loadWatts: 50_000, runtimeMinutes: POWER.minUpsRuntimeMinutes }),
      source('ckt-a', 'power_circuit', { feed: 'A', group: 'room-1', ratedWatts: 50_000, loadWatts: null }),
      source('ckt-b', 'power_circuit', { feed: 'B', group: 'room-1', ratedWatts: 50_000, loadWatts: 60_000 }),
    ];
    const findings = assessPower(sources, []);
    // PDU A (7 kW) cannot carry 8 kW if B fails; B (10 kW) can. The UPS pair fits; the circuits are not judged (A unmeasured).
    expect(findings).toContainEqual({ kind: 'pdu_failover_overload', ciId: 'pdu-a', partnerId: 'pdu-b', load: 8_000, capacity: 7_000 });
    expect(findings.filter((f) => f.kind.endsWith('failover_overload'))).toHaveLength(1);
    expect(findings).toContainEqual({ kind: 'ups_low_runtime', ciId: 'ups-a', partnerId: null, load: null, capacity: null });
    expect(findings.filter((f) => f.kind === 'ups_low_runtime')).toHaveLength(1);
  });

  it('counts cords against a PDU outlets', () => {
    const findings = assessPower([source('pdu-a', 'pdu', { outlets: 1 })], [
      { deviceId: 'd1', pduId: 'pdu-a', feed: 'A' },
      { deviceId: 'd2', pduId: 'pdu-a', feed: 'A' },
    ]);
    expect(findings).toContainEqual({ kind: 'outlets_exceeded', ciId: 'pdu-a', partnerId: null, load: 2, capacity: 1 });
  });
});
