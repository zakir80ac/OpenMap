// T-515 REQ-IPAM-003 — DNS sync planning: a zone with pending changes gets a job carrying them (one RFC 2136 update,
// then the transfer) on an online Node of its site with the dns collector; a zone without changes is pulled only when
// its pull is due; a zone with an unfinished job, or without a usable Node, gets none (the latter reported).
import { describe, expect, it } from 'vitest';
import { DNS_SYNC } from '@openmap/constants';
import { planDnsSync, type PendingChange, type SyncNode, type ZoneSync } from './dns-sync.js';

const now = new Date('2026-11-08T10:00:00.000Z');
const HOUR = 3_600_000;
const TENANT = '4b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e';
const sync = (id: string, zone: string, lastPullAt: Date | null, siteId = 'site-a'): ZoneSync => ({
  id, tenantId: TENANT, zone, server: '10.9.0.53', port: 53, tsigKeyName: 'openmap-sync', tsigAlgorithm: null, credentialRef: 'cred/dns', siteId, lastPullAt,
});
const node = (id: string, siteId: string, online = true, collectorIds: string[] = ['dns']): SyncNode => ({ id, tenantId: TENANT, siteId, online, collectorIds });
const change: PendingChange = { id: 'c1', zone: 'lab.example', op: 'add', name: 'api', recordType: 'A', value: '10.9.0.81', ttl: 600 };

describe('dns sync planning', () => {
  it('pushes pending changes with the transfer, on a Node of the zone site', () => {
    const plan = planDnsSync([sync('s1', 'lab.example', now)], new Map([['s1', [change]]]), [node('n-other', 'site-b'), node('n-a', 'site-a')], new Set(), now, HOUR);
    expect(plan.jobs).toHaveLength(1);
    const job = plan.jobs[0];
    expect(job).toMatchObject({ collectorId: DNS_SYNC.collectorId, nodeId: 'n-a', credentialRef: 'cred/dns', credentialType: DNS_SYNC.credentialType, targets: [{ kind: 'host', value: '10.9.0.53', label: 'lab.example' }] });
    expect(job?.options).toMatchObject({ zones: ['lab.example'], port: 53, tsigKeyName: 'openmap-sync', [DNS_SYNC.syncOption]: 's1' });
    expect(job?.options['updates']).toEqual([{ zone: 'lab.example', op: 'add', name: 'api', type: 'A', value: '10.9.0.81', ttl: 600 }]);
    expect(plan.sent.get('c1')).toBe(job?.jobId);
  });

  it('pulls a quiet zone only when due, and skips busy or unserved zones', () => {
    const syncs = [sync('due', 'a.example', new Date(now.getTime() - 2 * HOUR)), sync('fresh', 'b.example', new Date(now.getTime() - HOUR / 2)), sync('never', 'c.example', null), sync('busy', 'd.example', null), sync('nobody', 'e.example', null, 'site-z')];
    const plan = planDnsSync(syncs, new Map(), [node('n-a', 'site-a'), node('n-z', 'site-z', false)], new Set(['busy']), now, HOUR);
    expect(plan.jobs.map((j) => (j.options['zones'] as string[])[0]).sort()).toEqual(['a.example', 'c.example']);
    expect(plan.jobs.every((j) => (j.options['updates'] as unknown[]).length === 0)).toBe(true);
    expect(plan.unassigned).toEqual(['e.example']);
  });

  it('needs a Node that offers the dns collector', () => {
    const plan = planDnsSync([sync('s1', 'lab.example', null)], new Map([['s1', [change]]]), [node('n-a', 'site-a', true, ['snmp'])], new Set(), now, HOUR);
    expect(plan.jobs).toEqual([]);
    expect(plan.unassigned).toEqual(['lab.example']);
    expect(plan.sent.size).toBe(0);
  });
});
