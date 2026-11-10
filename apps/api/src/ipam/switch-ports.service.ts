// REQ-IPAM-004 (ADR-063) — switch port management over what discovery reports:
// - a device's ports (the `interface` CIs it contains) with state, speed, MTU and VLAN read from either attribute shape
//   collectors use, the neighbour on the far end (LLDP/CDP `connected_to`, a server NIC's `cabled_to`; cable records
//   people entered are not observations and are left out), and the MACs each port learned from the bridge forwarding
//   table, resolved to the IP addresses and CIs that carry them;
// - a port's history: the changes between its recorded versions in ClickHouse `ci_history`, and how long a down port
//   has not been up, so ports free to reuse are visible;
// - where a MAC address has been seen: learned on a switch port, in an ARP table (an `ip_address` CI with that MAC), or
//   as a CI's own address.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { SWITCH_PORTS, TIME } from '@openmap/constants';
import {
  SWITCH_PORT_ATTRIBUTES as P,
  daysNotUp,
  isUnused,
  learnedMacs,
  normaliseMac,
  portChanges,
  portNumber,
  portSpeedMbps,
  portState,
  portText,
  type PortChange,
  type PortState,
  type PortVersion,
  type RelationshipType,
} from '@openmap/contracts';
import { Prisma } from '@openmap/db';
import { withSpan } from '@openmap/telemetry';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord, RelationshipRecord } from '../ci/ci.types.js';
import { numberAttribute, stringAttribute } from '../common/validation.js';
import { ClickHouseService, clickhouseTime } from '../db/clickhouse.service.js';
import { PrismaService } from '../db/prisma.service.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';

const CONTAINS: RelationshipType = 'contains';
const CONNECTED_TO: RelationshipType = 'connected_to';
const CABLED_TO: RelationshipType = 'cabled_to';
const IN_VLAN: RelationshipType = 'in_vlan';
const USES_IP: RelationshipType = 'uses_ip';
/** On a `connected_to` from a cable or circuit to its end (ADR-056): a record people entered, not an observation. */
const CABLE_END = 'end';
const DEFAULT_PROTOCOL = 'lldp';

export interface LearnedMacView {
  mac: string;
  ip: string | null;
  ownerId: string | null;
}

export interface PortNeighbourView {
  ciId: string;
  port: string | null;
  protocol: string | null;
}

export interface SwitchPortView {
  portId: string;
  name: string;
  alias: string | null;
  state: PortState;
  speedMbps: number | null;
  mtu: number | null;
  vlan: number | null;
  learnedMacs: LearnedMacView[];
  learnedMacCount: number;
  neighbour: PortNeighbourView | null;
  lastChange: string | null;
  daysNotUp: number | null;
  unused: boolean;
}

export interface SwitchPortsView {
  deviceId: string;
  summary: {
    ports: number;
    up: number;
    down: number;
    adminDown: number;
    unknown: number;
    unused: number;
    learnedMacs: number;
  };
  ports: SwitchPortView[];
}

export interface PortHistoryView {
  portId: string;
  days: number;
  versions: number;
  changes: Array<{ at: string; key: string; from: string | null; to: string | null }>;
}

export type MacSightingKind = 'learned_on_port' | 'arp' | 'owner';

export interface MacSightingView {
  kind: MacSightingKind;
  ciId: string;
  port: string | null;
  ip: string | null;
  seenAt: string;
}

export interface MacLookupView {
  mac: string;
  sightings: MacSightingView[];
}

interface HistoryRow {
  ci: string;
  at_ms: string | number;
  attrs: string;
}

interface MacRow {
  id: string;
  type: string;
  mac: string;
  address: string | null;
  observedAt: Date;
}

interface PortRow {
  id: string;
  name: string;
  observedAt: Date;
  device: string | null;
}

/** Natural port order: Ethernet2 before Ethernet10, Gi1/0/2 before Gi1/0/10. */
export function comparePortNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function parseAttributes(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function portName(iface: CiRecord): string {
  return stringAttribute(iface.identity, 'name') ?? portText(iface.attributes, P.descr) ?? iface.name;
}

@Injectable()
export class SwitchPortsService {
  constructor(
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly prisma: PrismaService,
    private readonly clickhouse: ClickHouseService,
    private readonly metrics: MetricsService,
  ) {}

  /** Recorded versions of each CI from `historyDays` before `now`, plus the last one before that as the baseline. */
  private async versions(
    tenantId: string,
    ids: readonly string[],
    days: number,
    now: Date,
  ): Promise<Map<string, PortVersion[]>> {
    const out = new Map<string, PortVersion[]>();
    if (ids.length === 0) return out;
    const db = this.clickhouse.database;
    const from = clickhouseTime(new Date(now.getTime() - days * TIME.msPerDay));
    const params = { tenantId, ids: [...ids], from, limit: SWITCH_PORTS.maxHistoryVersions };
    const [inWindow, baseline] = await Promise.all([
      this.clickhouse.query<HistoryRow>(
        'port_history',
        'SELECT toString(ci_id) AS ci, toUnixTimestamp64Milli(valid_from) AS at_ms, argMax(attributes, recorded_at) AS attrs FROM ' +
          db +
          '.ci_history WHERE tenant_id = {tenantId:UUID} AND ci_id IN ({ids:Array(UUID)}) AND valid_from >= toDateTime64({from:String}, 3) GROUP BY ci_id, valid_from ORDER BY ci_id, valid_from LIMIT {limit:UInt32} BY ci_id',
        params,
      ),
      this.clickhouse.query<HistoryRow>(
        'port_history_baseline',
        'SELECT toString(ci_id) AS ci, toUnixTimestamp64Milli(max(valid_from)) AS at_ms, argMax(attributes, valid_from) AS attrs FROM ' +
          db +
          '.ci_history WHERE tenant_id = {tenantId:UUID} AND ci_id IN ({ids:Array(UUID)}) AND valid_from < toDateTime64({from:String}, 3) GROUP BY ci_id',
        params,
      ),
    ]);
    for (const row of [...baseline, ...inWindow]) {
      const list = out.get(row.ci) ?? [];
      list.push({ at: Number(row.at_ms), attributes: parseAttributes(row.attrs) });
      out.set(row.ci, list);
    }
    return out;
  }

  /** The versions of a port, falling back to its current Postgres row when ClickHouse has none recorded yet. */
  private versionsOf(port: CiRecord, recorded: ReadonlyMap<string, PortVersion[]>): PortVersion[] {
    const list = recorded.get(port.id) ?? [];
    const current: PortVersion = { at: Date.parse(port.validFrom), attributes: port.attributes };
    return list.some((v) => v.at === current.at) ? list : [...list, current];
  }

  /** MAC → the IP it was seen with and the CI that owns it (a CI carrying the MAC itself, else the IP's `uses_ip` owner). */
  private async resolveMacs(
    tenantId: string,
    macs: readonly string[],
  ): Promise<Map<string, { ip: string | null; ownerId: string | null }>> {
    const out = new Map<string, { ip: string | null; ownerId: string | null }>();
    if (macs.length === 0) return out;
    const rows = await this.macRows(tenantId, macs);
    const ips = rows.filter((r) => r.type === 'ip_address');
    const owners = new Map(
      rows.filter((r) => r.type !== 'ip_address' && r.type !== 'interface').map((r) => [r.mac, r.id]),
    );
    const ipOwners = ips.length
      ? await this.cis.relationshipsOfMany(
          tenantId,
          ips.map((r) => r.id),
          [USES_IP],
          'upstream',
        )
      : [];
    const ownerOfIp = new Map(ipOwners.map((r) => [r.toCiId, r.fromCiId]));
    for (const mac of macs) {
      const ip = ips.find((r) => r.mac === mac);
      out.set(mac, {
        ip: ip?.address ?? null,
        ownerId: owners.get(mac) ?? (ip === undefined ? null : (ownerOfIp.get(ip.id) ?? null)),
      });
    }
    return out;
  }

  /** Current CIs whose own MAC (or, for an IP address, the MAC it was seen with) is one of `macs`. */
  private macRows(tenantId: string, macs: readonly string[]): Promise<MacRow[]> {
    return this.prisma.client.$queryRaw<MacRow[]>(Prisma.sql`
      SELECT c.id, c.type::text AS "type", m.mac, c.identity->>'address' AS "address", c."observedAt"
      FROM cis c
      CROSS JOIN LATERAL (SELECT lower(coalesce(c.attributes->>'primaryMac', c.attributes->>'macAddress', c.attributes->>'mac', c.attributes->>'ifPhysAddress')) AS mac) m
      WHERE c."tenantId" = ${tenantId}::uuid AND c."validTo" IS NULL AND m.mac = ANY(${[...macs]}::text[])
      LIMIT ${SWITCH_PORTS.macLookupLimit * macs.length}`);
  }

  /** The far end of each port: an LLDP/CDP neighbour or a server NIC, never a recorded cable end. */
  private async neighbours(
    tenantId: string,
    ports: readonly CiRecord[],
  ): Promise<Map<string, PortNeighbourView>> {
    const ids = ports.map((p) => p.id);
    const [out, inbound, nics] = await Promise.all([
      this.cis.relationshipsOfMany(tenantId, ids, [CONNECTED_TO], 'downstream'),
      this.cis.relationshipsOfMany(tenantId, ids, [CONNECTED_TO], 'upstream'),
      this.cis.relationshipsOfMany(tenantId, ids, [CABLED_TO], 'upstream'),
    ]);
    const observed = (r: RelationshipRecord): boolean => r.attributes[CABLE_END] === undefined;
    const farIds = [
      ...new Set([
        ...out.filter(observed).map((r) => r.toCiId),
        ...inbound.filter(observed).map((r) => r.fromCiId),
        ...nics.map((r) => r.fromCiId),
      ]),
    ];
    const far = new Map((await this.cis.findByIds(tenantId, farIds)).map((c) => [c.id, c]));
    const farInterfaces = [...far.values()].filter((c) => c.type === 'interface').map((c) => c.id);
    const parents = farInterfaces.length
      ? await this.cis.relationshipsOfMany(tenantId, farInterfaces, [CONTAINS], 'upstream')
      : [];
    const deviceOf = new Map(parents.map((r) => [r.toCiId, r.fromCiId]));
    const result = new Map<string, PortNeighbourView>();
    const protocolOf = (r: RelationshipRecord): string | null => stringAttribute(r.attributes, 'protocol');
    const viaInterface = (
      portId: string,
      otherId: string,
      r: RelationshipRecord,
      remotePort: string | null,
    ): void => {
      const other = far.get(otherId);
      if (other === undefined || other.type === 'cable' || other.type === 'circuit' || result.has(portId))
        return;
      if (other.type === 'interface')
        result.set(portId, {
          ciId: deviceOf.get(other.id) ?? other.id,
          port: portName(other),
          protocol: protocolOf(r),
        });
      else result.set(portId, { ciId: other.id, port: remotePort, protocol: protocolOf(r) });
    };
    for (const r of out.filter(observed))
      viaInterface(r.fromCiId, r.toCiId, r, stringAttribute(r.attributes, 'remotePortId'));
    for (const r of inbound.filter(observed)) viaInterface(r.toCiId, r.fromCiId, r, null);
    for (const r of nics) {
      if (result.has(r.toCiId) || !far.has(r.fromCiId)) continue;
      result.set(r.toCiId, {
        ciId: r.fromCiId,
        port: stringAttribute(r.attributes, 'hostNic'),
        protocol: protocolOf(r) ?? DEFAULT_PROTOCOL,
      });
    }
    return result;
  }

  async switchPorts(tenantId: string, deviceId: string, now: Date = new Date()): Promise<SwitchPortsView> {
    return withSpan(TRACER_NAME, 'ipam.switch.ports', { 'openmap.tenant': tenantId }, async () => {
      const device = await this.cis.findById(tenantId, deviceId, null);
      if (device === null || device.validTo !== null)
        throw new NotFoundException('device ' + deviceId + ' not found');
      const contained = await this.cis.relationshipsOfMany(tenantId, [deviceId], [CONTAINS], 'downstream');
      const ports = (
        await this.cis.findByIds(
          tenantId,
          contained.map((r) => r.toCiId),
        )
      )
        .filter((c) => c.type === 'interface' && c.validTo === null)
        .sort((a, b) => comparePortNames(portName(a), portName(b)))
        .slice(0, SWITCH_PORTS.maxPortsPerDevice);
      const ids = ports.map((p) => p.id);
      const [neighbours, vlanRels, recorded] = await Promise.all([
        this.neighbours(tenantId, ports),
        ids.length
          ? this.cis.relationshipsOfMany(tenantId, ids, [IN_VLAN], 'downstream')
          : Promise.resolve([]),
        this.versions(tenantId, ids, SWITCH_PORTS.historyDays, now),
      ]);
      const vlans = new Map(
        (await this.cis.findByIds(tenantId, [...new Set(vlanRels.map((r) => r.toCiId))])).map((c) => [
          c.id,
          numberAttribute(c.attributes, 'vlanId'),
        ]),
      );
      const vlanOf = new Map(vlanRels.map((r) => [r.fromCiId, vlans.get(r.toCiId) ?? null]));
      const learned = new Map(ports.map((p) => [p.id, learnedMacs(p.attributes)]));
      const allMacs = [...new Set([...learned.values()].flatMap((l) => l.macs))];
      const resolved = await this.resolveMacs(tenantId, allMacs);
      const views: SwitchPortView[] = ports.map((p) => {
        const versions = this.versionsOf(p, recorded);
        const changes = portChanges(versions);
        const notUp = daysNotUp(versions, now.getTime());
        const l = learned.get(p.id) ?? { macs: [], count: 0 };
        const pvid = portNumber(p.attributes, P.pvid);
        return {
          portId: p.id,
          name: portName(p),
          alias: portText(p.attributes, P.alias),
          state: portState(p.attributes),
          speedMbps: portSpeedMbps(p.attributes),
          mtu: portNumber(p.attributes, P.mtu),
          vlan: vlanOf.get(p.id) ?? (pvid === null || pvid === 0 ? null : pvid),
          learnedMacs: l.macs.map((mac) => ({
            mac,
            ip: resolved.get(mac)?.ip ?? null,
            ownerId: resolved.get(mac)?.ownerId ?? null,
          })),
          learnedMacCount: l.count,
          neighbour: neighbours.get(p.id) ?? null,
          lastChange:
            changes.length === 0
              ? null
              : new Date(changes[changes.length - 1]?.at ?? now.getTime()).toISOString(),
          daysNotUp: notUp,
          unused: isUnused(notUp),
        };
      });
      const count = (state: PortState): number => views.filter((v) => v.state === state).length;
      this.metrics.switchPortReads.inc({ query: 'ports' });
      return {
        deviceId,
        summary: {
          ports: views.length,
          up: count('up'),
          down: count('down'),
          adminDown: count('admin_down'),
          unknown: count('unknown'),
          unused: views.filter((v) => v.unused).length,
          learnedMacs: views.reduce((n, v) => n + v.learnedMacCount, 0),
        },
        ports: views,
      };
    });
  }

  async portHistory(
    tenantId: string,
    portId: string,
    days: number = SWITCH_PORTS.historyDays,
    now: Date = new Date(),
  ): Promise<PortHistoryView> {
    return withSpan(TRACER_NAME, 'ipam.switch.port_history', { 'openmap.tenant': tenantId }, async () => {
      const port = await this.cis.findById(tenantId, portId, null);
      if (port === null || port.type !== 'interface')
        throw new NotFoundException('port ' + portId + ' not found');
      const versions = this.versionsOf(port, await this.versions(tenantId, [portId], days, now));
      const changes: PortChange[] = portChanges(versions);
      this.metrics.switchPortReads.inc({ query: 'history' });
      return {
        portId,
        days,
        versions: versions.length, // Newest first; changes made at one instant keep their key order (state before speed before alias).
        changes: [...changes]
          .sort((a, b) => b.at - a.at)
          .map((c) => ({ at: new Date(c.at).toISOString(), key: c.key, from: c.from, to: c.to })),
      };
    });
  }

  async macLookup(tenantId: string, text: string): Promise<MacLookupView> {
    return withSpan(TRACER_NAME, 'ipam.switch.mac_lookup', { 'openmap.tenant': tenantId }, async () => {
      const mac = normaliseMac(text);
      if (mac === null) return { mac: text.trim(), sightings: [] };
      const [onPorts, own] = await Promise.all([
        this.prisma.client.$queryRaw<PortRow[]>(Prisma.sql`
          SELECT c.id, coalesce(c.identity->>'name', c.attributes->>'ifDescr', c.name) AS "name", c."observedAt", r."fromCiId" AS "device"
          FROM cis c
          LEFT JOIN relationships r ON r."toCiId" = c.id AND r.type = 'contains' AND r."validTo" IS NULL
          WHERE c."tenantId" = ${tenantId}::uuid AND c."validTo" IS NULL AND c.type = 'interface'
            AND (c.attributes @> jsonb_build_object(${P.learnedMacs}::text, jsonb_build_array(${mac}::text))
              OR c.attributes @> jsonb_build_object(${P.learnedMacs}::text, jsonb_build_array(${mac.toUpperCase()}::text)))
          LIMIT ${SWITCH_PORTS.macLookupLimit}`),
        this.macRows(tenantId, [mac]),
      ]);
      const sightings: MacSightingView[] = [
        ...onPorts.map((r) => ({
          kind: 'learned_on_port' as const,
          ciId: r.device ?? r.id,
          port: r.name,
          ip: null,
          seenAt: r.observedAt.toISOString(),
        })),
        ...own.map((r) =>
          r.type === 'ip_address'
            ? {
                kind: 'arp' as const,
                ciId: r.id,
                port: null,
                ip: r.address,
                seenAt: r.observedAt.toISOString(),
              }
            : {
                kind: 'owner' as const,
                ciId: r.id,
                port: null,
                ip: null,
                seenAt: r.observedAt.toISOString(),
              },
        ),
      ].slice(0, SWITCH_PORTS.macLookupLimit);
      this.metrics.switchPortReads.inc({ query: 'mac' });
      return { mac, sightings };
    });
  }
}
