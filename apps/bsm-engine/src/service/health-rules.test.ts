// T-050 REQ-BSM-001 — health rules per CI type: power, link, replicas, certificates, staleness and passive records.
import { describe, expect, it } from 'vitest';
import type { Ci, CiType } from '@openmap/contracts';
import { deriveHealth } from './health-rules.js';

const NOW = '2026-10-22T12:00:00.000Z';
const FRESH = '2026-10-22T11:55:00.000Z';
const STALE = '2026-10-22T06:00:00.000Z';

function ci(type: CiType, attributes: Record<string, unknown>, observedAt = FRESH): Pick<Ci, 'type' | 'attributes' | 'observedAt' | 'lifecycle'> {
  return { type, attributes, observedAt, lifecycle: 'discovered' };
}

describe('deriveHealth', () => {
  it('reads power and status words on hosts and VMs', () => {
    expect(deriveHealth(ci('vm', { powerState: 'POWERED_OFF' }), NOW).health).toBe('down');
    expect(deriveHealth(ci('host', { health: 'degraded' }), NOW).health).toBe('degraded');
    expect(deriveHealth(ci('host', { powerSupplies: 2, powerSuppliesHealthy: 1 }), NOW).health).toBe('degraded');
    expect(deriveHealth(ci('hypervisor', { connectionState: 'CONNECTED', powerState: 'POWERED_ON' }), NOW).health).toBe('healthy');
  });

  it('treats interfaces by admin and oper status', () => {
    expect(deriveHealth(ci('interface', { adminStatus: 'down', operStatus: 'down' }), NOW).health).toBe('unknown');
    expect(deriveHealth(ci('interface', { adminStatus: 'up', operStatus: 'down' }), NOW).health).toBe('down');
    expect(deriveHealth(ci('port', { state: 'Online' }), NOW).health).toBe('healthy');
    expect(deriveHealth(ci('port', { state: 'No_Light' }), NOW).health).toBe('down');
  });

  it('grades certificates by expiry', () => {
    expect(deriveHealth(ci('certificate', { daysToExpiry: -1, expired: true }), NOW).health).toBe('down');
    expect(deriveHealth(ci('certificate', { daysToExpiry: 10, expired: false }), NOW).health).toBe('degraded');
    expect(deriveHealth(ci('certificate', { daysToExpiry: 300, expired: false }), NOW).health).toBe('healthy');
  });

  it('grades workloads and containers by readiness', () => {
    expect(deriveHealth(ci('k8s_workload', { replicasDesired: 3, replicasReady: 3 }), NOW).health).toBe('healthy');
    expect(deriveHealth(ci('k8s_workload', { replicasDesired: 3, replicasReady: 1 }), NOW).health).toBe('degraded');
    expect(deriveHealth(ci('k8s_workload', { replicasDesired: 3, replicasReady: 0 }), NOW).health).toBe('down');
    expect(deriveHealth(ci('container', { ready: false }), NOW).health).toBe('degraded');
  });

  it('marks stale liveness-bearing CIs unknown and passive records unknown', () => {
    expect(deriveHealth(ci('listening_service', {}), NOW).health).toBe('healthy');
    expect(deriveHealth(ci('listening_service', {}, STALE), NOW).health).toBe('unknown');
    expect(deriveHealth(ci('subnet', {}), NOW).health).toBe('unknown');
    expect(deriveHealth({ ...ci('host', {}), lifecycle: 'retired' }, NOW).health).toBe('unknown');
  });
});
