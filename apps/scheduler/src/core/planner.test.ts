// T-010 REQ-DISC-028 REQ-DISC-029
import { describe, expect, it } from 'vitest';
import { DISCOVERY } from '@openmap/constants';
import type { CollectorManifest } from '@openmap/contracts';
import { formatIpv4, hosts, parseCidr, parseIpv4 } from './cidr.js';
import { plan, retryDelayMs, withinBudget, type PlannerInput } from './planner.js';

const tenantId = '9b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e';
const manifest = (id: string, kinds: CollectorManifest['targetKinds']): CollectorManifest => ({
  id, family: 'snmp', version: '1.0.0', language: 'go', protocols: ['snmp'], credentialTypes: ['snmp_v3'], targetKinds: kinds, emits: ['network_device'], contractVersion: '0.1.0',
});

describe('cidr', () => {
  it('round-trips addresses and enumerates hosts minus exclusions', () => {
    expect(formatIpv4(parseIpv4('10.20.4.18'))).toBe('10.20.4.18');
    const c = parseCidr('10.20.4.0/29');
    const list = [...hosts(c, [parseCidr('10.20.4.4/30')])].map(formatIpv4);
    expect(list).toEqual(['10.20.4.1', '10.20.4.2', '10.20.4.3']);
    expect(() => parseCidr('10.20.4.0/40')).toThrow();
  });
});

describe('planner', () => {
  const base: PlannerInput = {
    tenantId,
    scopes: [{ id: 's1', siteId: 'ryd', collectorIds: ['snmp', 'ssh_agentless'], targets: [{ kind: 'cidr', value: '10.20.0.0/22' }], exclusions: ['10.20.3.0/24'], credentialRef: 'openmap/creds/snmp', credentialType: 'snmp_v3', options: {} }],
    nodes: [{ nodeId: 'node-ryd-01', siteId: 'ryd', online: true, maxConcurrency: 64 }, { nodeId: 'node-ryd-02', siteId: 'ryd', online: true, maxConcurrency: 64 }],
    manifests: [manifest('snmp', ['host', 'cidr']), manifest('ssh_agentless', ['host'])],
    secondsPerTarget: { snmp: 2, ssh_agentless: 6 },
    defaultSecondsPerTarget: 4,
    now: '2026-10-22T09:00:00.000Z',
  };
  it('expands CIDRs, applies exclusions, chunks into jobs and spreads across site nodes', () => {
    const p = plan(base);
    // /22 = 1024 addresses minus its own network and broadcast (2) minus the excluded /24 (255 remaining, its last address is the /22 broadcast).
    const hostsPerCollector = 1024 - 2 - 255;
    expect(p.targetsTotal).toBe(hostsPerCollector * 2);
    expect(p.jobs.every((j) => j.targets.length <= DISCOVERY.targetsPerJob)).toBe(true);
    expect(new Set(p.jobs.map((j) => j.nodeId)).size).toBe(2);
    expect(p.jobs.every((j) => j.options['sweepId'] === p.sweepId)).toBe(true);
    expect(p.unassignedScopeIds).toEqual([]);
  });
  it('reports scopes with no online node and leaves large CIDRs to the collector', () => {
    const p = plan({ ...base, nodes: [{ nodeId: 'n', siteId: 'jed', online: true, maxConcurrency: 8 }], scopes: [{ ...base.scopes[0]!, targets: [{ kind: 'cidr', value: '10.0.0.0/8' }] }, { ...base.scopes[0]!, id: 's2', siteId: 'jed', collectorIds: ['snmp'], targets: [{ kind: 'cidr', value: '10.0.0.0/8' }] }] });
    expect(p.unassignedScopeIds).toEqual(['s1']);
    expect(p.jobs).toHaveLength(1);
    expect(p.jobs[0]?.targets[0]?.kind).toBe('cidr');
  });
  it('estimates duration against the sweep budget', () => {
    const p = plan(base);
    expect(withinBudget(p)).toBe(true);
    const slow = plan({ ...base, secondsPerTarget: { snmp: 900, ssh_agentless: 900 } });
    expect(withinBudget(slow)).toBe(false);
  });
  it('backs off retries and stops', () => {
    expect(retryDelayMs(0)).toBe(DISCOVERY.retryBackoffMs[0]);
    expect(retryDelayMs(DISCOVERY.retryBackoffMs.length)).toBeNull();
  });
});
