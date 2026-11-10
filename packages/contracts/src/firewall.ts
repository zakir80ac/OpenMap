// REQ-IPAM-005 (ADR-064) — firewall rules and policy objects shared by the API, the console and the tests. A rule is
// read from the attributes collectors and the synthetic estate write on a `firewall_rule` CI (one ordered list per
// device, or nftables chains with jumps and a policy); a policy object is a `firewall_object` CI (an address or
// service group, an nftables set) that rules name as `@<name>`. Pure functions: matching a packet against addresses
// and services (IPv4 and IPv6, prefixes, ranges, objects, negation), evaluating a device's rules for a packet, and the
// rule analysis (shadowed, unused, permissive rules and objects no rule uses).
import { FIREWALL } from '@openmap/constants';

/** What a rule does when it matches. `continue` only counts or logs; `nat` translates and does not decide. */
export const FIREWALL_ACTIONS = [
  'allow',
  'deny',
  'reject',
  'nat',
  'jump',
  'goto',
  'return',
  'continue',
] as const;
export type FirewallAction = (typeof FIREWALL_ACTIONS)[number];

/** Actions that end evaluation with a verdict. */
export const FIREWALL_TERMINAL_ACTIONS: readonly FirewallAction[] = ['allow', 'deny', 'reject'];

export const FIREWALL_OBJECT_KINDS = ['address', 'service', 'interface', 'other'] as const;
export type FirewallObjectKind = (typeof FIREWALL_OBJECT_KINDS)[number];

export const FIREWALL_VERDICTS = ['allow', 'deny', 'reject', 'no_match'] as const;
export type FirewallVerdict = (typeof FIREWALL_VERDICTS)[number];

export const FIREWALL_FINDING_KINDS = ['shadowed', 'unused', 'permissive'] as const;
export type FirewallFindingKind = (typeof FIREWALL_FINDING_KINDS)[number];

/** Vendor spellings of an action, lower-cased. */
const ACTION_WORDS: Readonly<Record<string, FirewallAction>> = {
  allow: 'allow',
  accept: 'allow',
  permit: 'allow',
  pass: 'allow',
  deny: 'deny',
  drop: 'deny',
  block: 'deny',
  discard: 'deny',
  reject: 'reject',
  'reset-client': 'reject',
  'reset-server': 'reject',
  'reset-both': 'reject',
  nat: 'nat',
  dnat: 'nat',
  snat: 'nat',
  masquerade: 'nat',
  redirect: 'nat',
  jump: 'jump',
  goto: 'goto',
  return: 'return',
  continue: 'continue',
  log: 'continue',
  counter: 'continue',
};

/** Address and service words that mean "anything". */
const ANY_WORDS: ReadonlySet<string> = new Set(['', 'any', '*', 'all', '0.0.0.0/0', '::/0', 'any4', 'any6']);
const NEGATION = '!';
const OBJECT_PREFIX = '@';
const RANGE_SEPARATOR = '-';
const PREFIX_SEPARATOR = '/';
const IPV4_BITS = 32;
const IPV6_BITS = 128;
const IPV4_OCTETS = 4;
const IPV6_GROUPS = 8;
const OCTET_MAX = 255;
const GROUP_MAX = 0xffff;
const BITS_PER_OCTET = 8n;
const BITS_PER_GROUP = 16n;
const HEX_RADIX = 16;
const DECIMAL_RADIX = 10;
const PORT_MAX = 65_535;

/** IP protocol numbers collectors may report in place of names. */
const PROTOCOL_NUMBERS: Readonly<Record<string, string>> = {
  '1': 'icmp',
  '6': 'tcp',
  '17': 'udp',
  '58': 'icmpv6',
  '132': 'sctp',
};

export interface FirewallRuleView {
  /** The CI id. */
  id: string;
  name: string;
  ruleId: string;
  /** The chain the rule sits in; '' when the device keeps one ordered list (zone-based firewalls). */
  chain: string;
  /** The netfilter hook of a base chain (input, forward, output, prerouting, postrouting), or null. */
  hook: string | null;
  /** filter, nat, route… for nftables chains; null when the device does not say. */
  chainType: string | null;
  table: string | null;
  position: number;
  action: FirewallAction;
  /** The chain a jump or goto continues in, or the translation a NAT rule applies. */
  target: string | null;
  sources: string[];
  destinations: string[];
  services: string[];
  fromZone: string | null;
  toZone: string | null;
  inInterface: string | null;
  outInterface: string | null;
  /** Other match expressions (connection state, rate limits, marks…), as the device words them. */
  conditions: string[];
  /** Packets the rule matched, when the device counts them. */
  hitCount: number | null;
  logging: boolean;
  enabled: boolean;
  comment: string | null;
  /** A base chain's default policy, kept as the last rule of the chain. */
  isPolicy: boolean;
}

export interface FirewallObjectView {
  id: string;
  name: string;
  objectId: string;
  kind: FirewallObjectKind;
  elements: string[];
  comment: string | null;
}

export interface FirewallPacket {
  source: string;
  destination: string;
  /** tcp, udp, icmp… or 'any'. */
  protocol: string;
  port: number | null;
  fromZone?: string | null;
  toZone?: string | null;
  inInterface?: string | null;
  outInterface?: string | null;
}

export interface FirewallEvaluation {
  /** The chain evaluation started in ('' for a single ordered list). */
  chain: string;
  verdict: FirewallVerdict;
  /** The rule that decided, or null when nothing matched. */
  rule: FirewallRuleView | null;
  /** Chains walked, in order, starting with `chain`. */
  path: string[];
  /** Rules before the deciding one whose match could not be told from the packet (zone, interface, other conditions). */
  uncertain: FirewallRuleView[];
}

export interface FirewallFinding {
  /** The rule's CI id. */
  ruleId: string;
  kind: FirewallFindingKind;
  /** For `shadowed`: the earlier rule that matches everything this one does. */
  by: string | null;
  /** For `shadowed`: whether the earlier rule does the same thing (redundant) or the opposite (conflict). */
  sameAction: boolean | null;
}

export interface FirewallAnalysis {
  findings: FirewallFinding[];
  /** CI ids of objects no rule names. */
  unusedObjects: string[];
  /** True when the device has more rules than FIREWALL.analysisRuleLimit and only the first were analysed. */
  truncated: boolean;
}

type AttributeRecord = Readonly<Record<string, unknown>>;

function text(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter((v): v is string => v !== null);
  const one = text(value);
  if (one === null) return [];
  return one
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function count(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    return Number(value);
  return null;
}

function flag(value: unknown, otherwise: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'yes') return true;
  if (value === 'false' || value === 'no') return false;
  return otherwise;
}

/** The action a vendor word stands for, or null when it is not one. */
export function firewallAction(word: unknown): FirewallAction | null {
  const w = text(word);
  if (w === null) return null;
  return ACTION_WORDS[w.toLowerCase()] ?? null;
}

function positionOf(attributes: AttributeRecord, ruleId: string): number {
  const p = count(attributes['position']);
  if (p !== null) return p;
  const n = Number(ruleId);
  return Number.isFinite(n) ? n : 0;
}

function anyAsEmpty(values: string[]): string[] {
  return values.filter((v) => !ANY_WORDS.has(v.toLowerCase()));
}

/** A rule as the attributes of its `firewall_rule` CI describe it. */
export function firewallRuleFromAttributes(
  id: string,
  name: string,
  attributes: AttributeRecord,
): FirewallRuleView {
  const ruleId = text(attributes['ruleId']) ?? id;
  return {
    id,
    name: text(attributes['name']) ?? name,
    ruleId,
    chain: text(attributes['chain']) ?? '',
    hook: text(attributes['hook']),
    chainType: text(attributes['chainType']),
    table: text(attributes['table']),
    position: positionOf(attributes, ruleId),
    action: firewallAction(attributes['action']) ?? 'continue',
    target: text(attributes['target']),
    sources: anyAsEmpty(list(attributes['source'])),
    destinations: anyAsEmpty(list(attributes['destination'])),
    services: anyAsEmpty(list(attributes['service'])),
    fromZone: text(attributes['fromZone']),
    toZone: text(attributes['toZone']),
    inInterface: text(attributes['inInterface']),
    outInterface: text(attributes['outInterface']),
    conditions: list(attributes['conditions']),
    hitCount: count(attributes['hitCount']),
    logging: flag(attributes['logging'], false),
    enabled: flag(attributes['enabled'], true),
    comment: text(attributes['comment']),
    isPolicy: flag(attributes['isPolicy'], false),
  };
}

/** A policy object as the attributes of its `firewall_object` CI describe it. */
export function firewallObjectFromAttributes(
  id: string,
  name: string,
  attributes: AttributeRecord,
): FirewallObjectView {
  const kind = text(attributes['kind']);
  return {
    id,
    name: text(attributes['name']) ?? name,
    objectId: text(attributes['objectId']) ?? id,
    kind:
      kind !== null && (FIREWALL_OBJECT_KINDS as readonly string[]).includes(kind)
        ? (kind as FirewallObjectKind)
        : 'other',
    elements: list(attributes['elements']),
    comment: text(attributes['comment']),
  };
}

/** Rules in evaluation order: by chain, then position, then rule id. */
export function sortFirewallRules(rules: readonly FirewallRuleView[]): FirewallRuleView[] {
  return [...rules].sort((a, b) =>
    a.chain === b.chain
      ? a.position - b.position || compareText(a.ruleId, b.ruleId)
      : compareText(a.chain, b.chain),
  );
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// ---- addresses ----

interface IpValue {
  version: 4 | 6;
  value: bigint;
}

function parseIpv4(s: string): bigint | null {
  const parts = s.split('.');
  if (parts.length !== IPV4_OCTETS) return null;
  let v = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/u.test(p)) return null;
    const n = Number.parseInt(p, DECIMAL_RADIX);
    if (n > OCTET_MAX) return null;
    v = (v << BITS_PER_OCTET) + BigInt(n);
  }
  return v;
}

function parseIpv6(s: string): bigint | null {
  if (!s.includes(':')) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === undefined || halves[0] === '' ? [] : halves[0].split(':');
  const tail =
    halves.length === 2 ? (halves[1] === undefined || halves[1] === '' ? [] : halves[1].split(':')) : [];
  // An embedded IPv4 tail (::ffff:10.0.0.1) counts as two groups.
  const groups: string[] = [];
  const expand = (parts: string[]): string[] | null => {
    const out: string[] = [];
    for (const p of parts) {
      if (p.includes('.')) {
        const v4 = parseIpv4(p);
        if (v4 === null) return null;
        out.push(
          ((v4 >> BITS_PER_GROUP) & BigInt(GROUP_MAX)).toString(HEX_RADIX),
          (v4 & BigInt(GROUP_MAX)).toString(HEX_RADIX),
        );
      } else out.push(p);
    }
    return out;
  };
  const h = expand(head);
  const t = expand(tail);
  if (h === null || t === null) return null;
  if (halves.length === 2) {
    const missing = IPV6_GROUPS - h.length - t.length;
    if (missing < 1) return null;
    groups.push(...h, ...Array<string>(missing).fill('0'), ...t);
  } else groups.push(...h);
  if (groups.length !== IPV6_GROUPS) return null;
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/iu.test(g)) return null;
    v = (v << BITS_PER_GROUP) + BigInt(Number.parseInt(g, HEX_RADIX));
  }
  return v;
}

/** An IPv4 or IPv6 address as a number, or null. */
export function parseIp(s: string): IpValue | null {
  const t = s.trim();
  const v4 = parseIpv4(t);
  if (v4 !== null) return { version: 4, value: v4 };
  const v6 = parseIpv6(t);
  if (v6 !== null) return { version: 6, value: v6 };
  return null;
}

interface AddressRange {
  version: 4 | 6;
  from: bigint;
  to: bigint;
}

type AddressItem = { kind: 'range'; range: AddressRange } | { kind: 'literal'; value: string };

function rangeOf(spec: string): AddressRange | null {
  const slash = spec.indexOf(PREFIX_SEPARATOR);
  if (slash > 0) {
    const ip = parseIp(spec.slice(0, slash));
    const len = Number(spec.slice(slash + 1));
    const bits = ip?.version === 4 ? IPV4_BITS : IPV6_BITS;
    if (ip === null || !Number.isInteger(len) || len < 0 || len > bits) return null;
    const host = (1n << BigInt(bits - len)) - 1n;
    const from = ip.value & ~host & ((1n << BigInt(bits)) - 1n);
    return { version: ip.version, from, to: from + host };
  }
  const dash = spec.indexOf(RANGE_SEPARATOR);
  if (dash > 0) {
    const a = parseIp(spec.slice(0, dash));
    const b = parseIp(spec.slice(dash + 1));
    if (a === null || b === null || a.version !== b.version || a.value > b.value) return null;
    return { version: a.version, from: a.value, to: b.value };
  }
  const ip = parseIp(spec);
  return ip === null ? null : { version: ip.version, from: ip.value, to: ip.value };
}

function objectIndex(objects: readonly FirewallObjectView[]): Map<string, FirewallObjectView> {
  const byName = new Map<string, FirewallObjectView>();
  for (const o of objects) byName.set(o.name.toLowerCase(), o);
  return byName;
}

/** Expands `@object` references (nested groups too, to FIREWALL.maxObjectDepth) into plain specs. */
function expand(specs: readonly string[], objects: Map<string, FirewallObjectView>, depth = 0): string[] {
  const out: string[] = [];
  for (const spec of specs) {
    if (spec.startsWith(OBJECT_PREFIX) && depth < FIREWALL.maxObjectDepth) {
      const o = objects.get(spec.slice(OBJECT_PREFIX.length).toLowerCase());
      if (o !== undefined) {
        out.push(...expand(o.elements, objects, depth + 1));
        continue;
      }
    }
    out.push(spec);
  }
  return out;
}

function addressItems(specs: readonly string[]): AddressItem[] {
  return specs.map((s) => {
    const range = rangeOf(s);
    return range === null ? { kind: 'literal', value: s.toLowerCase() } : { kind: 'range', range };
  });
}

function splitNegated(specs: readonly string[]): { positive: string[]; negated: string[] } {
  const positive: string[] = [];
  const negated: string[] = [];
  for (const s of specs) {
    if (ANY_WORDS.has(s.trim().toLowerCase())) continue;
    if (s.startsWith(NEGATION)) negated.push(s.slice(NEGATION.length).trim());
    else positive.push(s);
  }
  return { positive, negated };
}

function itemContains(item: AddressItem, address: string, ip: IpValue | null): boolean {
  if (item.kind === 'literal') return item.value === address.toLowerCase();
  return (
    ip !== null &&
    ip.version === item.range.version &&
    ip.value >= item.range.from &&
    ip.value <= item.range.to
  );
}

/** Whether an address falls in a rule's address list (empty means any; `!x` excludes x). */
export function addressMatches(
  specs: readonly string[],
  address: string,
  objects: readonly FirewallObjectView[] = [],
): boolean {
  const index = objectIndex(objects);
  const { positive, negated } = splitNegated(specs);
  const ip = parseIp(address);
  const pos = addressItems(expand(positive, index));
  const neg = addressItems(expand(negated, index));
  if (pos.length > 0 && !pos.some((i) => itemContains(i, address, ip))) return false;
  return !neg.some((i) => itemContains(i, address, ip));
}

// ---- services ----

interface ServiceItem {
  /** Lower-case protocol, or '*' for any protocol. */
  protocol: string;
  /** Port range, or null for every port; ICMP types are kept in `name`. */
  from: number | null;
  to: number | null;
  name: string | null;
}

function protocolName(p: string): string {
  const lower = p.trim().toLowerCase();
  return PROTOCOL_NUMBERS[lower] ?? lower;
}

function portRange(s: string): { from: number; to: number } | null {
  const dash = s.indexOf(RANGE_SEPARATOR);
  const a = Number(dash > 0 ? s.slice(0, dash) : s);
  const b = Number(dash > 0 ? s.slice(dash + 1) : s);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b > PORT_MAX || a > b) return null;
  return { from: a, to: b };
}

/** A service spec ('tcp/443', 'udp/1000-2000', 'icmp/echo-request', 'tcp', '443') as items, objects expanded. */
function serviceItems(spec: string, objects: Map<string, FirewallObjectView>, depth = 0): ServiceItem[] {
  if (spec.startsWith(OBJECT_PREFIX)) {
    const o =
      depth < FIREWALL.maxObjectDepth
        ? objects.get(spec.slice(OBJECT_PREFIX.length).toLowerCase())
        : undefined;
    if (o === undefined) return [{ protocol: '*', from: null, to: null, name: spec.toLowerCase() }];
    return o.elements.flatMap((e) => serviceItems(e, objects, depth + 1));
  }
  const slash = spec.indexOf(PREFIX_SEPARATOR);
  if (slash < 0) {
    const ports = portRange(spec);
    if (ports !== null) return [{ protocol: '*', ...ports, name: null }];
    return [{ protocol: protocolName(spec), from: null, to: null, name: null }];
  }
  const protocol = protocolName(spec.slice(0, slash));
  const rest = spec.slice(slash + 1).trim();
  if (rest.startsWith(OBJECT_PREFIX)) {
    const o =
      depth < FIREWALL.maxObjectDepth
        ? objects.get(rest.slice(OBJECT_PREFIX.length).toLowerCase())
        : undefined;
    if (o === undefined) return [{ protocol, from: null, to: null, name: rest.toLowerCase() }];
    return o.elements.flatMap((e) =>
      serviceItems(e.includes(PREFIX_SEPARATOR) ? e : protocol + PREFIX_SEPARATOR + e, objects, depth + 1),
    );
  }
  const ports = portRange(rest);
  if (ports !== null) return [{ protocol, ...ports, name: null }];
  return [{ protocol, from: null, to: null, name: rest.toLowerCase() }];
}

function serviceItemMatches(item: ServiceItem, protocol: string, port: number | null): boolean {
  const p = protocolName(protocol);
  if (item.protocol !== '*' && p !== 'any' && item.protocol !== p) return false;
  // A named item (an ICMP type) matches a packet of its protocol when the check names no port: the type is not asked.
  if (item.name !== null) return item.protocol !== '*' && port === null;
  if (item.from === null || item.to === null) return true;
  return port !== null && port >= item.from && port <= item.to;
}

/** Whether a protocol and port fall in a rule's service list (empty means any; `!x` excludes x). */
export function serviceMatches(
  specs: readonly string[],
  protocol: string,
  port: number | null,
  objects: readonly FirewallObjectView[] = [],
): boolean {
  const index = objectIndex(objects);
  const { positive, negated } = splitNegated(specs);
  const pos = positive.flatMap((s) => serviceItems(s, index));
  const neg = negated.flatMap((s) => serviceItems(s, index));
  if (pos.length > 0 && !pos.some((i) => serviceItemMatches(i, protocol, port))) return false;
  return !neg.some((i) => serviceItemMatches(i, protocol, port));
}

// ---- evaluation ----

type Tri = 'yes' | 'no' | 'maybe';

function sameWord(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function constraint(ruleValue: string | null, packetValue: string | null | undefined): Tri {
  if (ruleValue === null || ANY_WORDS.has(ruleValue.toLowerCase())) return 'yes';
  if (packetValue === undefined || packetValue === null || packetValue === '') return 'maybe';
  return sameWord(ruleValue, packetValue) ? 'yes' : 'no';
}

const CT_STATE = /^ct state\s+(?<states>.+)$/u;
const RATE_LIMIT = /^limit\b/u;

/** How a condition holds for the first packet of a new connection. */
function conditionHolds(condition: string): Tri {
  const c = condition.trim().toLowerCase();
  const ct = CT_STATE.exec(c);
  if (ct?.groups?.['states'] !== undefined) {
    const negated = ct.groups['states'].startsWith(NEGATION);
    const states = ct.groups['states'].replace(NEGATION, '').split(/[\s,]+/u);
    const hasNew = states.includes('new');
    return hasNew !== negated ? 'yes' : 'no';
  }
  if (RATE_LIMIT.test(c)) return 'yes';
  return 'maybe';
}

function combine(values: readonly Tri[]): Tri {
  if (values.includes('no')) return 'no';
  if (values.includes('maybe')) return 'maybe';
  return 'yes';
}

/** Whether a rule matches a new connection's first packet: yes, no, or maybe when the packet does not tell. */
export function ruleMatches(
  rule: FirewallRuleView,
  packet: FirewallPacket,
  objects: readonly FirewallObjectView[] = [],
): Tri {
  if (!rule.enabled) return 'no';
  if (rule.isPolicy) return 'yes';
  const checks: Tri[] = [
    addressMatches(rule.sources, packet.source, objects) ? 'yes' : 'no',
    addressMatches(rule.destinations, packet.destination, objects) ? 'yes' : 'no',
    serviceMatches(rule.services, packet.protocol, packet.port, objects) ? 'yes' : 'no',
    constraint(rule.fromZone, packet.fromZone),
    constraint(rule.toZone, packet.toZone),
    constraint(rule.inInterface, packet.inInterface),
    constraint(rule.outInterface, packet.outInterface),
    ...rule.conditions.map(conditionHolds),
  ];
  return combine(checks);
}

/** The chains evaluation can start in: base filter chains, or the single list of a zone-based device. */
export function firewallEntryChains(rules: readonly FirewallRuleView[]): string[] {
  const chains = new Set<string>();
  for (const r of rules) {
    if (r.chain === '') chains.add('');
    else if (r.hook !== null && (r.chainType === null || r.chainType === 'filter')) chains.add(r.chain);
  }
  return [...chains].sort(compareText);
}

interface WalkResult {
  decided: { verdict: FirewallVerdict; rule: FirewallRuleView } | null;
  /** A goto ended without a verdict: the calling base chain ends too. */
  endBase: boolean;
}

/** Evaluates a device's rules for a packet, starting in one chain. */
export function evaluateFirewall(
  rules: readonly FirewallRuleView[],
  objects: readonly FirewallObjectView[],
  packet: FirewallPacket,
  chain: string,
): FirewallEvaluation {
  const byChain = new Map<string, FirewallRuleView[]>();
  for (const r of sortFirewallRules(rules)) {
    const inChain = byChain.get(r.chain) ?? [];
    inChain.push(r);
    byChain.set(r.chain, inChain);
  }
  const path: string[] = [];
  const uncertain: FirewallRuleView[] = [];

  const walk = (name: string, depth: number): WalkResult => {
    path.push(name);
    for (const rule of byChain.get(name) ?? []) {
      if (rule.isPolicy) continue;
      const m = ruleMatches(rule, packet, objects);
      if (m === 'no') continue;
      if (m === 'maybe') {
        uncertain.push(rule);
        continue;
      }
      switch (rule.action) {
        case 'allow':
        case 'deny':
        case 'reject':
          return { decided: { verdict: rule.action, rule }, endBase: false };
        case 'jump':
        case 'goto': {
          if (rule.target === null || depth >= FIREWALL.maxJumpDepth) continue;
          const r = walk(rule.target, depth + 1);
          if (r.decided !== null || r.endBase) return r;
          if (rule.action === 'goto') return { decided: null, endBase: true };
          continue;
        }
        case 'return':
          return { decided: null, endBase: false };
        case 'nat':
        case 'continue':
          continue;
      }
    }
    return { decided: null, endBase: false };
  };

  const result = walk(chain, 0);
  if (result.decided !== null)
    return { chain, verdict: result.decided.verdict, rule: result.decided.rule, path, uncertain };
  const policy = (byChain.get(chain) ?? []).find(
    (r) => r.isPolicy && FIREWALL_TERMINAL_ACTIONS.includes(r.action),
  );
  if (policy !== undefined)
    return { chain, verdict: policy.action as FirewallVerdict, rule: policy, path, uncertain };
  return { chain, verdict: 'no_match', rule: null, path, uncertain };
}

// ---- analysis ----

function addressRangesCover(outer: readonly AddressItem[], inner: AddressItem): boolean {
  if (inner.kind === 'literal') return outer.some((o) => o.kind === 'literal' && o.value === inner.value);
  // Merge the outer ranges of the same version so adjacent prefixes together cover a wider one.
  const ranges = outer
    .filter(
      (o): o is { kind: 'range'; range: AddressRange } =>
        o.kind === 'range' && o.range.version === inner.range.version,
    )
    .map((o) => o.range)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  // Sweep from the inner range's start: every address up to its end must sit in some outer range, with no gap.
  let cursor = inner.range.from;
  for (const r of ranges) {
    if (r.to < cursor) continue;
    if (r.from > cursor) return false;
    cursor = r.to + 1n;
    if (cursor > inner.range.to) return true;
  }
  return false;
}

function addressesCover(
  outer: readonly string[],
  inner: readonly string[],
  objects: Map<string, FirewallObjectView>,
): boolean {
  if (outer.length === 0) return true;
  if (inner.length === 0) return false;
  const o = expand(outer, objects);
  const i = expand(inner, objects);
  if (o.some((s) => s.startsWith(NEGATION)) || i.some((s) => s.startsWith(NEGATION))) return false;
  const outerItems = addressItems(o);
  return addressItems(i).every((item) => addressRangesCover(outerItems, item));
}

function servicesCover(
  outer: readonly string[],
  inner: readonly string[],
  objects: Map<string, FirewallObjectView>,
): boolean {
  if (outer.length === 0) return true;
  if (inner.length === 0) return false;
  if (outer.some((s) => s.startsWith(NEGATION)) || inner.some((s) => s.startsWith(NEGATION))) return false;
  const o = outer.flatMap((s) => serviceItems(s, objects));
  return inner
    .flatMap((s) => serviceItems(s, objects))
    .every((b) =>
      o.some((a) => {
        if (a.protocol !== '*' && a.protocol !== b.protocol) return false;
        if (a.name !== null || b.name !== null) return a.name === b.name;
        if (a.from === null || a.to === null) return true;
        return b.from !== null && b.to !== null && a.from <= b.from && a.to >= b.to;
      }),
    );
}

function sameConstraint(a: string | null, b: string | null): boolean {
  if (a === null || ANY_WORDS.has(a.toLowerCase())) return true;
  return b !== null && sameWord(a, b);
}

/** Whether `earlier` matches every packet `later` matches, so `later` is never reached. */
export function ruleCovers(
  earlier: FirewallRuleView,
  later: FirewallRuleView,
  objects: readonly FirewallObjectView[] = [],
): boolean {
  if (!earlier.enabled || earlier.isPolicy || later.isPolicy) return false;
  if (!FIREWALL_TERMINAL_ACTIONS.includes(earlier.action)) return false;
  if (earlier.conditions.length > 0 || earlier.chain !== later.chain) return false;
  if (!sameConstraint(earlier.fromZone, later.fromZone) || !sameConstraint(earlier.toZone, later.toZone))
    return false;
  if (
    !sameConstraint(earlier.inInterface, later.inInterface) ||
    !sameConstraint(earlier.outInterface, later.outInterface)
  )
    return false;
  const index = objectIndex(objects);
  return (
    addressesCover(earlier.sources, later.sources, index) &&
    addressesCover(earlier.destinations, later.destinations, index) &&
    servicesCover(earlier.services, later.services, index)
  );
}

/** The names (lower-cased) of the policy objects a rule references as `@name`. */
export function firewallObjectReferences(rule: FirewallRuleView): string[] {
  return [...rule.sources, ...rule.destinations, ...rule.services, ...rule.conditions].flatMap((spec) => {
    const s = spec.startsWith(NEGATION) ? spec.slice(NEGATION.length) : spec;
    const at = s.indexOf(OBJECT_PREFIX);
    return at < 0 ? [] : [s.slice(at + OBJECT_PREFIX.length).toLowerCase()];
  });
}

/** Shadowed, unused and permissive rules of one device, and the objects no rule names. */
export function analyseFirewall(
  rules: readonly FirewallRuleView[],
  objects: readonly FirewallObjectView[],
): FirewallAnalysis {
  const sorted = sortFirewallRules(rules);
  const truncated = sorted.length > FIREWALL.analysisRuleLimit;
  const analysed = truncated ? sorted.slice(0, FIREWALL.analysisRuleLimit) : sorted;
  const findings: FirewallFinding[] = [];
  const byChain = new Map<string, FirewallRuleView[]>();
  for (const r of analysed) {
    const inChain = byChain.get(r.chain) ?? [];
    inChain.push(r);
    byChain.set(r.chain, inChain);
  }
  for (const chainRules of byChain.values()) {
    chainRules.forEach((rule, i) => {
      if (rule.isPolicy) return;
      for (let j = 0; j < i; j++) {
        const earlier = chainRules[j];
        if (earlier !== undefined && ruleCovers(earlier, rule, objects)) {
          findings.push({
            ruleId: rule.id,
            kind: 'shadowed',
            by: earlier.id,
            sameAction: earlier.action === rule.action,
          });
          break;
        }
      }
      if (rule.hitCount === 0 && rule.enabled)
        findings.push({ ruleId: rule.id, kind: 'unused', by: null, sameAction: null });
      // Any service from or to anywhere; a rule bound to an interface (loopback) or a condition is narrower than that.
      const bound = rule.inInterface !== null || rule.outInterface !== null || rule.conditions.length > 0;
      if (
        rule.action === 'allow' &&
        !bound &&
        rule.services.length === 0 &&
        (rule.sources.length === 0 || rule.destinations.length === 0)
      ) {
        findings.push({ ruleId: rule.id, kind: 'permissive', by: null, sameAction: null });
      }
    });
  }
  const used = new Set(analysed.flatMap(firewallObjectReferences));
  // A group used by a used group is used too.
  let grew = true;
  while (grew) {
    grew = false;
    for (const o of objects) {
      if (!used.has(o.name.toLowerCase())) continue;
      for (const e of o.elements) {
        if (!e.startsWith(OBJECT_PREFIX)) continue;
        const n = e.slice(OBJECT_PREFIX.length).toLowerCase();
        if (!used.has(n)) {
          used.add(n);
          grew = true;
        }
      }
    }
  }
  const unusedObjects = objects.filter((o) => !used.has(o.name.toLowerCase())).map((o) => o.id);
  return { findings, unusedObjects, truncated };
}
