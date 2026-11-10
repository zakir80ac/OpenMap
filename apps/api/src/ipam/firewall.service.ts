// REQ-IPAM-005 (ADR-064) — firewall rules and policy objects as discovery reports them: the `firewall_rule` and
// `firewall_object` CIs a device (a firewall appliance, or a host with nftables) contains. A device's policy lists its
// rules in evaluation order with the analysis (shadowed, unused and permissive rules, objects no rule names); a traffic
// check evaluates a new connection against each device's rules (or one device's) and names the rule that decides. The
// matching and evaluation live in packages/contracts/src/firewall.ts and are shared with the tests.
import { Injectable, NotFoundException } from '@nestjs/common';
import { FIREWALL } from '@openmap/constants';
import {
  analyseFirewall,
  evaluateFirewall,
  firewallEntryChains,
  firewallObjectFromAttributes,
  firewallObjectReferences,
  firewallRuleFromAttributes,
  sortFirewallRules,
  type FirewallAction,
  type FirewallFindingKind,
  type FirewallObjectView,
  type FirewallPacket,
  type FirewallRuleView,
  type FirewallVerdict,
} from '@openmap/contracts';
import { Prisma } from '@openmap/db';
import { withSpan } from '@openmap/telemetry';
import { PrismaService } from '../db/prisma.service.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';

const RULE_TYPE = 'firewall_rule';
const OBJECT_TYPE = 'firewall_object';

export interface FirewallFindingView {
  kind: FirewallFindingKind;
  byRuleId: string | null;
  byName: string | null;
  sameAction: boolean | null;
}

export type FirewallRuleOut = FirewallRuleView & { findings: FirewallFindingView[] };

export interface FirewallObjectOut extends FirewallObjectView {
  ruleCount: number;
  unused: boolean;
}

export interface FirewallChainView {
  name: string;
  hook: string | null;
  chainType: string | null;
  rules: number;
  policy: FirewallAction | null;
}

export interface FirewallPolicyView {
  deviceId: string;
  summary: {
    rules: number;
    allow: number;
    deny: number;
    nat: number;
    objects: number;
    shadowed: number;
    unused: number;
    permissive: number;
    unusedObjects: number;
  };
  chains: FirewallChainView[];
  rules: FirewallRuleOut[];
  objects: FirewallObjectOut[];
  truncated: boolean;
}

export interface FirewallDeviceView {
  deviceId: string;
  rules: number;
  objects: number;
}

export interface FirewallCheckInput extends FirewallPacket {
  deviceId: string | null;
}

export interface FirewallCheckResultView {
  deviceId: string;
  chain: string;
  verdict: FirewallVerdict;
  rule: FirewallRuleOut | null;
  path: string[];
  uncertain: FirewallRuleOut[];
}

export interface FirewallCheckView {
  evaluated: number;
  truncated: boolean;
  results: FirewallCheckResultView[];
}

interface MemberRow {
  device: string;
  deviceName: string;
  id: string;
  type: string;
  name: string;
  attributes: Prisma.JsonValue;
}

interface DeviceRow {
  device: string;
  rules: bigint | number;
  objects: bigint | number;
}

interface DeviceFirewall {
  deviceId: string;
  deviceName: string;
  rules: FirewallRuleView[];
  objects: FirewallObjectView[];
}

function record(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function withoutFindings(rule: FirewallRuleView): FirewallRuleOut {
  return { ...rule, findings: [] };
}

@Injectable()
export class FirewallService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  /** The current rules and objects each device contains: one device, or every device of the tenant up to the cap. */
  private async load(tenantId: string, deviceId: string | null): Promise<DeviceFirewall[]> {
    const deviceFilter = deviceId === null ? Prisma.empty : Prisma.sql`AND r."fromCiId" = ${deviceId}::uuid`;
    const limit = deviceId === null ? FIREWALL.maxRulesPerTenant : FIREWALL.maxRulesPerDevice;
    const rows = await this.prisma.client.$queryRaw<MemberRow[]>(Prisma.sql`
      SELECT r."fromCiId"::text AS device, d.name AS "deviceName", c.id::text AS id, c.type::text AS type, c.name, c.attributes
      FROM relationships r
      JOIN cis c ON c.id = r."toCiId" AND c."validTo" IS NULL
      JOIN cis d ON d.id = r."fromCiId" AND d."validTo" IS NULL
      WHERE r."tenantId" = ${tenantId}::uuid AND r.type = 'contains' AND r."validTo" IS NULL
        AND c.type IN (${RULE_TYPE}::"CiType", ${OBJECT_TYPE}::"CiType") ${deviceFilter}
      ORDER BY d.name, r."fromCiId", c.id
      LIMIT ${limit}`);
    const byDevice = new Map<string, DeviceFirewall>();
    for (const row of rows) {
      const entry = byDevice.get(row.device) ?? {
        deviceId: row.device,
        deviceName: row.deviceName,
        rules: [],
        objects: [],
      };
      const attributes = record(row.attributes);
      if (row.type === RULE_TYPE) entry.rules.push(firewallRuleFromAttributes(row.id, row.name, attributes));
      else entry.objects.push(firewallObjectFromAttributes(row.id, row.name, attributes));
      byDevice.set(row.device, entry);
    }
    return [...byDevice.values()];
  }

  /** Devices with firewall rules whose name contains the text (case-insensitive), with their rule and object counts. */
  async devices(tenantId: string, text: string): Promise<FirewallDeviceView[]> {
    return withSpan(TRACER_NAME, 'ipam.firewall.devices', { 'openmap.tenant': tenantId }, async () => {
      const needle = text.trim().toLowerCase();
      const rows = await this.prisma.client.$queryRaw<DeviceRow[]>(Prisma.sql`
        SELECT r."fromCiId"::text AS device,
               count(*) FILTER (WHERE c.type = ${RULE_TYPE}::"CiType") AS rules,
               count(*) FILTER (WHERE c.type = ${OBJECT_TYPE}::"CiType") AS objects
        FROM relationships r
        JOIN cis c ON c.id = r."toCiId" AND c."validTo" IS NULL
        JOIN cis d ON d.id = r."fromCiId" AND d."validTo" IS NULL
        WHERE r."tenantId" = ${tenantId}::uuid AND r.type = 'contains' AND r."validTo" IS NULL
          AND c.type IN (${RULE_TYPE}::"CiType", ${OBJECT_TYPE}::"CiType")
          AND (${needle} = '' OR position(${needle} in lower(d.name)) > 0)
        GROUP BY r."fromCiId", d.name
        HAVING count(*) FILTER (WHERE c.type = ${RULE_TYPE}::"CiType") > 0
        ORDER BY d.name
        LIMIT ${FIREWALL.deviceSearchLimit}`);
      this.metrics.firewallReads.inc({ query: 'devices' });
      return rows.map((r) => ({ deviceId: r.device, rules: Number(r.rules), objects: Number(r.objects) }));
    });
  }

  /** A device's rules in evaluation order with their findings, its chains, and its objects with how many rules use each. */
  async policy(tenantId: string, deviceId: string): Promise<FirewallPolicyView> {
    return withSpan(TRACER_NAME, 'ipam.firewall.policy', { 'openmap.tenant': tenantId }, async () => {
      const [device] = await this.load(tenantId, deviceId);
      if (device === undefined || device.rules.length === 0)
        throw new NotFoundException('no firewall rules on device ' + deviceId);
      const rules = sortFirewallRules(device.rules);
      const analysis = analyseFirewall(rules, device.objects);
      const byId = new Map(rules.map((r) => [r.id, r]));
      const findings = new Map<string, FirewallFindingView[]>();
      for (const f of analysis.findings) {
        const by = f.by === null ? undefined : byId.get(f.by);
        const list = findings.get(f.ruleId) ?? [];
        list.push({
          kind: f.kind,
          byRuleId: by?.ruleId ?? null,
          byName: by?.name ?? null,
          sameAction: f.sameAction,
        });
        findings.set(f.ruleId, list);
      }
      const references = new Map<string, number>();
      for (const r of rules)
        for (const name of new Set(firewallObjectReferences(r)))
          references.set(name, (references.get(name) ?? 0) + 1);
      const unusedObjects = new Set(analysis.unusedObjects);
      const chains = new Map<string, FirewallChainView>();
      for (const r of rules) {
        const chain = chains.get(r.chain) ?? {
          name: r.chain,
          hook: r.hook,
          chainType: r.chainType,
          rules: 0,
          policy: null,
        };
        if (r.isPolicy) chain.policy = r.action;
        else chain.rules += 1;
        chains.set(r.chain, chain);
      }
      const out = rules.map((r) => ({ ...r, findings: findings.get(r.id) ?? [] }));
      const count = (kind: FirewallFindingKind): number =>
        analysis.findings.filter((f) => f.kind === kind).length;
      const real = rules.filter((r) => !r.isPolicy);
      this.metrics.firewallReads.inc({ query: 'policy' });
      return {
        deviceId,
        summary: {
          rules: real.length,
          allow: real.filter((r) => r.action === 'allow').length,
          deny: real.filter((r) => r.action === 'deny' || r.action === 'reject').length,
          nat: real.filter((r) => r.action === 'nat').length,
          objects: device.objects.length,
          shadowed: count('shadowed'),
          unused: count('unused'),
          permissive: count('permissive'),
          unusedObjects: unusedObjects.size,
        },
        chains: [...chains.values()],
        rules: out,
        objects: device.objects
          .map((o) => ({
            ...o,
            ruleCount: references.get(o.name.toLowerCase()) ?? 0,
            unused: unusedObjects.has(o.id),
          }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
        truncated: analysis.truncated,
      };
    });
  }

  /** What each device (or one) does with a new connection, per entry chain, and the rule that decides. */
  async check(tenantId: string, input: FirewallCheckInput): Promise<FirewallCheckView> {
    return withSpan(TRACER_NAME, 'ipam.firewall.check', { 'openmap.tenant': tenantId }, async () => {
      const devices = await this.load(tenantId, input.deviceId);
      if (input.deviceId !== null && devices.length === 0)
        throw new NotFoundException('no firewall rules on device ' + input.deviceId);
      const withRules = devices.filter((d) => d.rules.length > 0);
      const evaluated = withRules.slice(0, FIREWALL.checkDeviceLimit);
      const packet: FirewallPacket = {
        source: input.source,
        destination: input.destination,
        protocol: input.protocol,
        port: input.port,
        fromZone: input.fromZone ?? null,
        toZone: input.toZone ?? null,
        inInterface: input.inInterface ?? null,
        outInterface: input.outInterface ?? null,
      };
      const results: FirewallCheckResultView[] = [];
      for (const d of evaluated) {
        for (const chain of firewallEntryChains(d.rules)) {
          const e = evaluateFirewall(d.rules, d.objects, packet, chain);
          results.push({
            deviceId: d.deviceId,
            chain: e.chain,
            verdict: e.verdict,
            rule: e.rule === null ? null : withoutFindings(e.rule),
            path: e.path,
            uncertain: e.uncertain.map(withoutFindings),
          });
        }
      }
      this.metrics.firewallReads.inc({ query: 'check' });
      return { evaluated: evaluated.length, truncated: withRules.length > evaluated.length, results };
    });
  }
}
