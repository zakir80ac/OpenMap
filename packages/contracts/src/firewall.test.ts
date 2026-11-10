// T-559 REQ-IPAM-005 (ADR-064) — firewall matching, evaluation and analysis over rules shaped as the SSH collector
// emits a host's nftables rule set (chains, jumps, policies, sets) and as zone-based firewalls report one ordered list.
import { describe, expect, it } from 'vitest';
import {
  addressMatches,
  analyseFirewall,
  evaluateFirewall,
  firewallAction,
  firewallEntryChains,
  firewallObjectFromAttributes,
  firewallRuleFromAttributes,
  parseIp,
  ruleCovers,
  serviceMatches,
  type FirewallObjectView,
  type FirewallRuleView,
} from './firewall.js';

const object = (name: string, kind: string, elements: string[]): FirewallObjectView =>
  firewallObjectFromAttributes('obj-' + name, name, {
    objectId: 'inet/filter/' + name,
    name,
    kind,
    elements,
  });

let seq = 0;
const rule = (attributes: Record<string, unknown>): FirewallRuleView => {
  seq += 1;
  return firewallRuleFromAttributes('rule-' + String(seq), 'rule ' + String(seq), {
    ruleId: String(seq),
    ...attributes,
  });
};

// The lab host's rule set (packages/testing/fixtures/vendor/ssh_agentless/debian-debian-12-nftables).
const INPUT = 'inet filter input';
const FORWARD = 'inet filter forward';
const DOCKER = 'inet filter docker_user';
const base = (chain: string, hook: string) => ({ chain, hook, chainType: 'filter', table: 'inet filter' });
const hostObjects = [
  object('admin_nets', 'address', ['10.20.0.0/16', '172.16.0.0/12', '192.168.0.0/16']),
  object('web_ports', 'service', ['80', '443', '8443']),
  object('monitoring_hosts', 'address', ['10.30.1.10', '10.30.1.11']),
];
const hostRules = [
  rule({
    ...base(INPUT, 'input'),
    position: 1,
    action: 'allow',
    conditions: ['ct state established,related'],
    comment: 'return traffic',
  }),
  rule({
    ...base(INPUT, 'input'),
    position: 2,
    action: 'deny',
    conditions: ['ct state invalid'],
    hitCount: 0,
  }),
  rule({ ...base(INPUT, 'input'), position: 3, action: 'allow', inInterface: 'lo', comment: 'loopback' }),
  rule({
    ...base(INPUT, 'input'),
    position: 4,
    action: 'allow',
    service: ['icmp/destination-unreachable', 'icmp/echo-request', 'icmp/time-exceeded'],
    conditions: ['limit rate 10/second'],
  }),
  rule({
    ...base(INPUT, 'input'),
    position: 5,
    action: 'allow',
    source: ['@admin_nets'],
    service: ['tcp/22'],
    hitCount: 1,
    comment: 'ssh from admin networks',
  }),
  rule({
    ...base(INPUT, 'input'),
    position: 6,
    action: 'allow',
    service: ['tcp/@web_ports'],
    hitCount: 0,
    comment: 'web',
  }),
  rule({
    ...base(INPUT, 'input'),
    position: 7,
    action: 'allow',
    source: ['@monitoring_hosts'],
    service: ['udp/161'],
    hitCount: 0,
  }),
  rule({
    ...base(INPUT, 'input'),
    position: 8,
    action: 'allow',
    source: ['10.40.0.0/16'],
    service: ['tcp/5432', 'tcp/6432'],
    hitCount: 0,
  }),
  rule({
    ...base(INPUT, 'input'),
    position: 9,
    action: 'reject',
    service: ['tcp/3306'],
    hitCount: 0,
    comment: 'mysql closed',
  }),
  rule({ ...base(INPUT, 'input'), position: 10, action: 'deny', logging: true, hitCount: 0 }),
  rule({ ...base(INPUT, 'input'), position: 11, action: 'deny', isPolicy: true }),
  rule({
    ...base(FORWARD, 'forward'),
    position: 1,
    action: 'allow',
    conditions: ['ct state established,related'],
  }),
  rule({ ...base(FORWARD, 'forward'), position: 2, action: 'jump', target: DOCKER }),
  rule({ ...base(FORWARD, 'forward'), position: 3, action: 'deny', isPolicy: true }),
  rule({
    chain: DOCKER,
    table: 'inet filter',
    position: 1,
    action: 'allow',
    source: ['10.88.0.0/16'],
    destination: ['10.40.0.0/16'],
    hitCount: 0,
  }),
  rule({ chain: DOCKER, table: 'inet filter', position: 2, action: 'return' }),
  rule({
    chain: 'ip nat prerouting',
    hook: 'prerouting',
    chainType: 'nat',
    position: 1,
    action: 'nat',
    service: ['tcp/8080'],
    target: 'dnat to 10.88.0.10:80',
  }),
];

describe('addresses and services', () => {
  it('reads IPv4 and IPv6, prefixes, ranges, objects and negation', () => {
    expect(parseIp('10.0.0.1')?.version).toBe(4);
    expect(parseIp('2001:db8::1')?.version).toBe(6);
    expect(parseIp('::ffff:10.0.0.1')?.version).toBe(6);
    expect(parseIp('10.0.0.256')).toBeNull();
    expect(addressMatches([], '203.0.113.9')).toBe(true);
    expect(addressMatches(['any'], '203.0.113.9')).toBe(true);
    expect(addressMatches(['10.20.0.0/16'], '10.20.255.1')).toBe(true);
    expect(addressMatches(['10.20.0.0/16'], '10.21.0.1')).toBe(false);
    expect(addressMatches(['10.0.0.10-10.0.0.20'], '10.0.0.15')).toBe(true);
    expect(addressMatches(['2001:db8::/32'], '2001:db8:ffff::1')).toBe(true);
    expect(addressMatches(['2001:db8::/32'], '10.0.0.1')).toBe(false);
    expect(addressMatches(['@admin_nets'], '192.168.112.1', hostObjects)).toBe(true);
    expect(addressMatches(['@admin_nets'], '10.99.0.1', hostObjects)).toBe(false);
    expect(addressMatches(['!10.0.0.0/8'], '10.1.1.1')).toBe(false);
    expect(addressMatches(['!10.0.0.0/8'], '192.0.2.1')).toBe(true);
    const nested = [object('all_admin', 'address', ['@admin_nets', '10.50.0.1']), ...hostObjects];
    expect(addressMatches(['@all_admin'], '172.20.1.1', nested)).toBe(true);
    expect(addressMatches(['@all_admin'], '10.50.0.1', nested)).toBe(true);
    expect(addressMatches(['web-servers'], 'WEB-SERVERS')).toBe(true);
  });

  it('reads protocol and port specs, port sets, ranges, ICMP types and protocol numbers', () => {
    expect(serviceMatches([], 'udp', 53)).toBe(true);
    expect(serviceMatches(['tcp/22'], 'tcp', 22)).toBe(true);
    expect(serviceMatches(['tcp/22'], 'udp', 22)).toBe(false);
    expect(serviceMatches(['tcp/@web_ports'], 'tcp', 8443, hostObjects)).toBe(true);
    expect(serviceMatches(['tcp/@web_ports'], 'tcp', 8080, hostObjects)).toBe(false);
    expect(serviceMatches(['udp/1000-2000'], 'udp', 1500)).toBe(true);
    expect(serviceMatches(['tcp'], 'tcp', 9999)).toBe(true);
    expect(serviceMatches(['6/443'], 'tcp', 443)).toBe(true);
    expect(serviceMatches(['icmp/echo-request'], 'icmp', null)).toBe(true);
    expect(serviceMatches(['icmp/echo-request'], 'tcp', null)).toBe(false);
    expect(serviceMatches(['!tcp/22'], 'tcp', 22)).toBe(false);
    expect(serviceMatches(['!tcp/22'], 'tcp', 23)).toBe(true);
    expect(firewallAction('ACCEPT')).toBe('allow');
    expect(firewallAction('drop')).toBe('deny');
    expect(firewallAction('masquerade')).toBe('nat');
    expect(firewallAction('bogus')).toBeNull();
  });
});

describe('evaluation', () => {
  it('starts in the base filter chains, not NAT chains or jump targets', () => {
    expect(firewallEntryChains(hostRules)).toEqual([FORWARD, INPUT]);
  });

  it('decides a new connection by the first rule that matches, and notes the rules it could not tell', () => {
    const ssh = evaluateFirewall(
      hostRules,
      hostObjects,
      { source: '10.20.4.5', destination: '192.168.112.2', protocol: 'tcp', port: 22 },
      INPUT,
    );
    expect(ssh.verdict).toBe('allow');
    expect(ssh.rule?.comment).toBe('ssh from admin networks');
    // Established/invalid state rules do not match a new connection; the loopback rule cannot be told without an interface.
    expect(ssh.uncertain.map((r) => r.comment)).toEqual(['loopback']);
    const sshOutside = evaluateFirewall(
      hostRules,
      hostObjects,
      { source: '10.99.0.1', destination: '192.168.112.2', protocol: 'tcp', port: 22, inInterface: 'eth0' },
      INPUT,
    );
    expect(sshOutside.verdict).toBe('deny');
    expect(sshOutside.rule?.position).toBe(10);
    expect(sshOutside.uncertain).toEqual([]);
    const mysql = evaluateFirewall(
      hostRules,
      hostObjects,
      { source: '10.40.1.1', destination: '192.168.112.2', protocol: 'tcp', port: 3306, inInterface: 'eth0' },
      INPUT,
    );
    expect(mysql.verdict).toBe('reject');
    const ping = evaluateFirewall(
      hostRules,
      hostObjects,
      {
        source: '10.99.0.1',
        destination: '192.168.112.2',
        protocol: 'icmp',
        port: null,
        inInterface: 'eth0',
      },
      INPUT,
    );
    expect(ping.verdict).toBe('allow');
  });

  it('follows jumps and returns, and falls to the chain policy', () => {
    const toApp = evaluateFirewall(
      hostRules,
      hostObjects,
      { source: '10.88.0.7', destination: '10.40.2.2', protocol: 'tcp', port: 5432 },
      FORWARD,
    );
    expect(toApp.verdict).toBe('allow');
    expect(toApp.path).toEqual([FORWARD, DOCKER]);
    const out = evaluateFirewall(
      hostRules,
      hostObjects,
      { source: '10.88.0.7', destination: '198.51.100.1', protocol: 'tcp', port: 443 },
      FORWARD,
    );
    expect(out.verdict).toBe('deny');
    expect(out.rule?.isPolicy).toBe(true);
  });

  it('stops at a goto that ends without a verdict, so the base chain policy decides', () => {
    const rules = [
      rule({ ...base('t in', 'input'), position: 1, action: 'goto', target: 't side' }),
      rule({ ...base('t in', 'input'), position: 2, action: 'allow' }),
      rule({ ...base('t in', 'input'), position: 3, action: 'deny', isPolicy: true }),
      rule({ chain: 't side', position: 1, action: 'allow', service: ['udp/53'] }),
    ];
    expect(
      evaluateFirewall(
        rules,
        [],
        { source: '10.0.0.1', destination: '10.0.0.2', protocol: 'tcp', port: 80 },
        't in',
      ).verdict,
    ).toBe('deny');
    expect(
      evaluateFirewall(
        rules,
        [],
        { source: '10.0.0.1', destination: '10.0.0.2', protocol: 'udp', port: 53 },
        't in',
      ).verdict,
    ).toBe('allow');
  });

  it('evaluates a zone-based list in rule order and reports no match when nothing applies', () => {
    const list = [
      rule({
        ruleId: '10',
        action: 'allow',
        fromZone: 'trust',
        toZone: 'dmz',
        source: '10.1.0.0/24',
        destination: '10.2.0.0/24',
        service: 'tcp/443',
      }),
      rule({
        ruleId: '20',
        action: 'deny',
        fromZone: 'untrust',
        toZone: 'trust',
        source: 'any',
        destination: 'any',
        service: 'any',
      }),
    ];
    expect(firewallEntryChains(list)).toEqual(['']);
    const zoned = evaluateFirewall(
      list,
      [],
      {
        source: '10.1.0.5',
        destination: '10.2.0.9',
        protocol: 'tcp',
        port: 443,
        fromZone: 'trust',
        toZone: 'dmz',
      },
      '',
    );
    expect(zoned.verdict).toBe('allow');
    const unknownZone = evaluateFirewall(
      list,
      [],
      { source: '10.1.0.5', destination: '10.2.0.9', protocol: 'tcp', port: 443 },
      '',
    );
    expect(unknownZone.verdict).toBe('no_match');
    expect(unknownZone.uncertain.map((r) => r.ruleId)).toEqual(['10', '20']);
  });
});

describe('analysis', () => {
  it('finds shadowed rules (redundant or conflicting), including prefixes that together cover a wider one', () => {
    const chain = { chain: 'c', hook: 'input', chainType: 'filter' };
    const wide = rule({ ...chain, position: 1, action: 'allow', source: ['10.0.0.0/8'], service: ['tcp'] });
    const narrow = rule({
      ...chain,
      position: 2,
      action: 'allow',
      source: ['10.1.0.0/16'],
      service: ['tcp/443'],
    });
    const conflict = rule({
      ...chain,
      position: 3,
      action: 'deny',
      source: ['10.2.3.4'],
      service: ['tcp/22'],
    });
    const halfA = rule({
      ...chain,
      position: 4,
      action: 'deny',
      source: ['192.168.0.0/25'],
      service: ['udp/53'],
    });
    const halfB = rule({
      ...chain,
      position: 5,
      action: 'deny',
      source: ['192.168.0.128/25'],
      service: ['udp/53'],
    });
    const joined = rule({
      ...chain,
      position: 6,
      action: 'deny',
      source: ['192.168.0.0/24'],
      service: ['udp/53'],
    });
    const stateful = rule({
      ...chain,
      position: 7,
      action: 'allow',
      source: ['172.16.0.0/12'],
      conditions: ['ct state established'],
    });
    const afterStateful = rule({
      ...chain,
      position: 8,
      action: 'deny',
      source: ['172.16.1.1'],
      service: ['tcp/80'],
    });
    const rules = [wide, narrow, conflict, halfA, halfB, joined, stateful, afterStateful];
    const covered = (r: FirewallRuleView) =>
      analyseFirewall(rules, []).findings.find((f) => f.ruleId === r.id && f.kind === 'shadowed');
    expect(covered(narrow)).toMatchObject({ by: wide.id, sameAction: true });
    expect(covered(conflict)).toMatchObject({ by: wide.id, sameAction: false });
    expect(ruleCovers(halfA, joined)).toBe(false);
    expect(covered(joined)).toBeUndefined();
    // Two /25s together cover the /24 only as one merged set of ranges, which needs them in one rule.
    const both = rule({
      ...chain,
      position: 9,
      action: 'deny',
      source: ['192.168.0.0/25', '192.168.0.128/25'],
      service: ['udp/53'],
    });
    expect(ruleCovers(both, joined)).toBe(true);
    // A rule with a condition never shadows: it does not match every packet the later one does.
    expect(covered(afterStateful)).toBeUndefined();
  });

  it('reports unused and permissive rules and objects no rule names', () => {
    const extra = [...hostObjects, object('legacy_dmz', 'address', ['10.60.0.0/16'])];
    const permissive = rule({
      ...base(INPUT, 'input'),
      position: 20,
      action: 'allow',
      source: ['@admin_nets'],
    });
    const { findings, unusedObjects, truncated } = analyseFirewall([...hostRules, permissive], extra);
    const kinds = (kind: string) => findings.filter((f) => f.kind === kind).map((f) => f.ruleId);
    const byComment = (c: string) => hostRules.find((r) => r.comment === c)?.id;
    expect(kinds('unused')).toContain(byComment('web'));
    expect(kinds('unused')).not.toContain(byComment('ssh from admin networks'));
    // The loopback accept is bound to an interface, so it is not reported.
    expect(kinds('permissive')).toEqual([permissive.id]);
    expect(unusedObjects).toEqual(['obj-legacy_dmz']);
    expect(truncated).toBe(false);
  });
});
