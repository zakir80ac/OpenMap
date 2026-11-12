// T-660 REQ-UI-037 — the twin drill-down's grouping: each neighbour lands in the section an operator reads it under,
// both directions count, duplicates collapse, services come from direct links and from the upstream walk once each,
// sections keep their reading order and leave empty ones out, and items needing attention come first.
import { describe, expect, it } from 'vitest';
import type { CiLayer } from '@openmap/contracts';
import { DRILL_SECTIONS, drillSections, sectionOf, type DrillRelationship } from './twin-drill';
import type { AffectedService, CiSummary } from './queries';

function ci(id: string, type: string, layer: CiLayer, health: CiSummary['health'] = 'healthy'): CiSummary {
  return { id, name: id, displayName: id, code: id.toUpperCase(), type, layer, health };
}

const host = ci('srv-01', 'host', 'hardware');
let next = 0;
function rel(type: string, from: CiSummary, to: CiSummary): DrillRelationship {
  next += 1;
  return { id: 'r' + String(next), type, from, to };
}

function service(target: CiSummary, path: string[]): AffectedService {
  return { service: target, tier: 1, predicted: 'down', path, usersAffected: null, revenueAtRiskPerHour: null, slaBudgetRemainingMinutes: null, recovery: null };
}

describe('sectionOf', () => {
  it('places each kind of neighbour where an operator looks for it', () => {
    expect(sectionOf(ci('vm', 'vm', 'virtualization'))).toBe('compute');
    expect(sectionOf(ci('hv', 'hypervisor', 'virtualization'))).toBe('compute');
    expect(sectionOf(ci('pod', 'k8s_workload', 'containers'))).toBe('compute');
    expect(sectionOf(ci('blade', 'blade', 'hardware'))).toBe('compute');
    expect(sectionOf(ci('bmc', 'bmc', 'hardware'))).toBe('components');
    expect(sectionOf(ci('os', 'operating_system', 'os'))).toBe('os');
    expect(sectionOf(ci('db', 'database', 'databases'))).toBe('databases');
    expect(sectionOf(ci('app', 'application', 'applications'))).toBe('applications');
    expect(sectionOf(ci('m365', 'saas_tenant', 'saas'))).toBe('applications');
    expect(sectionOf(ci('svc', 'business_service', 'applications'))).toBe('services');
    expect(sectionOf(ci('ip', 'ip_address', 'network_security'))).toBe('network');
    expect(sectionOf(ci('vlan', 'vlan', 'network_security'))).toBe('network');
    expect(sectionOf(ci('lun', 'lun', 'storage'))).toBe('storage');
    expect(sectionOf(ci('fw', 'firewall_rule', 'network_security'))).toBe('security');
    expect(sectionOf(ci('cert', 'certificate', 'network_security'))).toBe('security');
    expect(sectionOf(ci('cve', 'vulnerability', 'applications'))).toBe('security');
    expect(sectionOf(ci('dell', 'vendor', 'applications'))).toBe('commercial');
    expect(sectionOf(ci('prosupport', 'contract', 'applications'))).toBe('commercial');
    expect(sectionOf(ci('rack', 'rack', 'dc'))).toBe('place');
    expect(sectionOf(ci('pdu', 'pdu', 'dc'))).toBe('place');
    expect(sectionOf(ci('x', 'something', 'unknown'))).toBe('other');
  });
});

describe('drillSections', () => {
  it('groups both directions in reading order and leaves empty sections out', () => {
    const hv = ci('esxi-01', 'hypervisor', 'virtualization');
    const os = ci('rhel-9', 'operating_system', 'os');
    const ip = ci('10.0.0.5', 'ip_address', 'network_security');
    const rack = ci('rack-a1', 'rack', 'dc');
    const sections = drillSections(host.id, [rel('runs_on', hv, host), rel('installed_on', os, host), rel('uses_ip', host, ip), rel('located_in', host, rack)]);
    expect(sections.map((s) => s.key)).toEqual(['compute', 'os', 'network', 'place']);
    expect(sections.map((s) => s.key)).toEqual(DRILL_SECTIONS.filter((k) => sections.some((s) => s.key === k)));
    const compute = sections.find((s) => s.key === 'compute');
    expect(compute?.items[0]).toEqual({ ci: hv, relation: 'runs_on', outgoing: false, hops: null });
    expect(sections.find((s) => s.key === 'network')?.items[0]?.outgoing).toBe(true);
  });

  it('collapses a neighbour related the same way twice but keeps a different relation', () => {
    const sw = ci('sw-01', 'network_device', 'network_security');
    const sections = drillSections(host.id, [rel('connected_to', host, sw), rel('connected_to', host, sw), rel('cabled_to', host, sw)]);
    const network = sections.find((s) => s.key === 'network');
    expect(network?.items.map((i) => i.relation)).toEqual(['cabled_to', 'connected_to']);
  });

  it('adds the services the upstream walk reached, once, with their distance, after the directly linked ones', () => {
    const linked = ci('payments', 'business_service', 'applications');
    const reached = ci('checkout', 'business_service', 'applications');
    const sections = drillSections(host.id, [rel('part_of_service', host, linked)], [service(linked, [host.id, linked.id]), service(reached, [host.id, 'vm', 'app', reached.id])]);
    const services = sections.find((s) => s.key === 'services');
    expect(services?.items.map((i) => [i.ci.id, i.relation, i.hops])).toEqual([
      ['checkout', null, 3],
      ['payments', 'part_of_service', null],
    ]);
  });

  it('lists what needs attention first, then by name', () => {
    const a = ci('vm-a', 'vm', 'virtualization', 'healthy');
    const b = ci('vm-b', 'vm', 'virtualization', 'down');
    const c = ci('vm-c', 'vm', 'virtualization', 'degraded');
    const compute = drillSections(host.id, [rel('runs_on', a, host), rel('runs_on', b, host), rel('runs_on', c, host)]).find((s) => s.key === 'compute');
    expect(compute?.items.map((i) => i.ci.id)).toEqual(['vm-b', 'vm-c', 'vm-a']);
  });

  it('ignores a relationship of the CI to itself', () => {
    expect(drillSections(host.id, [rel('depends_on', host, host)])).toEqual([]);
  });
});
