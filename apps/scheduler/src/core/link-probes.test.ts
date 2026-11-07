// T-478 REQ-BSM-007 (ADR-025) — link probe planning: a link goes to an online Node at its A-end site that offers
// link_probe, else to any such Node of its tenant; one job per Node carries every link it probes, each target labelled
// with the link CI id; a busy Node is skipped; a link no Node can take is counted unassigned.
import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSIONS, LINK_PROBE } from '@openmap/constants';
import { planLinkProbes, type ProbeLink, type ProbeNode } from './link-probes.js';

const T = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const link = (ciId: string, from: string | null, tenantId = T): ProbeLink => ({ tenantId, ciId, fromSiteCode: from, probeTarget: 'gw-' + ciId + ':443' });
const node = (id: string, siteCode: string, over: Partial<ProbeNode> = {}): ProbeNode => ({ id, tenantId: T, siteCode, online: true, collectorIds: [LINK_PROBE.collectorId], ...over });
const now = '2026-11-08T00:00:00.000Z';

describe('planLinkProbes', () => {
  it('sends each link to a Node at its A end, else to any capable Node of the tenant', () => {
    const r = planLinkProbes([link('l1', 'RYD'), link('l2', 'JED'), link('l3', 'HQ')], [node('n-ryd', 'RYD'), node('n-jed', 'JED')], new Set(), now);
    expect(r.unassigned).toBe(0);
    const byNode = Object.fromEntries(r.jobs.map((j) => [j.nodeId, j.targets.map((t) => t.label)]));
    // HQ has no Node: its link goes to the first capable Node by id.
    expect(byNode).toEqual({ 'n-jed': ['l2', 'l3'], 'n-ryd': ['l1'] });
    const job = r.jobs.find((j) => j.nodeId === 'n-ryd');
    expect(job).toMatchObject({ tenantId: T, collectorId: LINK_PROBE.collectorId, credentialRef: null, credentialType: 'none', contractVersion: CONTRACT_VERSIONS.collector, scheduledAt: now });
    expect(job?.targets[0]).toEqual({ kind: 'host', value: 'gw-l1:443', label: 'l1' });
  });

  it('skips offline, incapable and busy Nodes and counts what no Node takes', () => {
    const nodes = [node('n-off', 'RYD', { online: false }), node('n-snmp', 'RYD', { collectorIds: ['snmp'] }), node('n-busy', 'JED')];
    const r = planLinkProbes([link('l1', 'RYD'), link('l2', 'JED'), link('l9', 'RYD', OTHER)], nodes, new Set(['n-busy']), now);
    // l1 falls back to n-busy (the only capable Node), which is busy: no job; l9's tenant has no Node at all.
    expect(r.jobs).toEqual([]);
    expect(r.unassigned).toBe(1);
  });
});
