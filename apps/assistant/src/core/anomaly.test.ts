// T-503 REQ-AI-003 — the anomaly rules as pure functions:
// - an address with two claimants is a conflict, one claimant (or one claimant twice) is not;
// - an unknown device in a data centre or colocation site is flagged, elsewhere it is not;
// - a service with ANOMALY.flapChanges changes inside the window flaps, the same number spread wider does not;
// - the explanation prompt carries the facts and asks for the requested language.
import { describe, expect, it } from 'vitest';
import { ANOMALY, TIME } from '@openmap/constants';
import { anomalyExplanationMessages, flappingServices, ipConflicts, unmanagedInDatacenter, type HealthChange } from './anomaly.js';

describe('anomaly rules', () => {
  it('flags an address two CIs claim', () => {
    const claim = (ip: string, id: string, name: string, type: string) => ({ ipCiId: ip, address: '10.64.0.5', claimantId: id, claimantName: name, claimantType: type });
    const hits = ipConflicts([claim('ip1', 'h1', 'srv-ryd-app-01', 'host'), claim('ip1', 'u1', 'iot_sensor-b6ff', 'unknown'), claim('ip2', 'h2', 'srv-02', 'host'), claim('ip2', 'h2', 'srv-02', 'host')]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ rule: 'ip_conflict', subjectCiId: 'ip1' });
    expect(hits[0]?.facts).toContainEqual({ key: 'claimants', value: 'iot_sensor-b6ff (unknown), srv-ryd-app-01 (host)' });
  });

  it('flags unknown devices in data centres only', () => {
    const d = (id: string, siteKind: string | null) => ({ ciId: id, name: id, siteName: 'site', siteKind, address: null, vendor: 'Axis', firstSeen: null });
    expect(unmanagedInDatacenter([d('a', 'datacenter'), d('b', 'colocation'), d('c', 'branch'), d('d', null)]).map((h) => h.subjectCiId)).toEqual(['a', 'b']);
  });

  it('flags a service whose changes crowd one window, not the same changes spread out', () => {
    const at = (n: number, gapMs: number): HealthChange[] => Array.from({ length: n }, (_, i) => ({ serviceId: 's', serviceName: 'Cards', at: i * gapMs, health: i % 2 === 0 ? 'down' : 'healthy' }));
    const windowMs = ANOMALY.flapWindowHours * TIME.msPerHour;
    const crowded = flappingServices(at(ANOMALY.flapChanges, windowMs / ANOMALY.flapChanges));
    expect(crowded).toHaveLength(1);
    expect(crowded[0]?.facts).toContainEqual({ key: 'changes', value: String(ANOMALY.flapChanges) });
    expect(flappingServices(at(ANOMALY.flapChanges, windowMs))).toEqual([]);
  });

  it('asks the model to explain from the facts, in the locale', () => {
    const [system, user] = anomalyExplanationMessages('ip_conflict', [{ key: 'address', value: '10.64.0.5' }], 'ar');
    expect(system?.content).toContain('Arabic');
    expect(user?.content).toContain('10.64.0.5');
  });
});
