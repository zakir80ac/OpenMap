// REQ-DCIM-007 (ADR-061) — capacity planning for a room: per rack the free units and their contiguous blocks, the
// design power against the latest measured PDU draw, the live against total ports of its network devices; for the
// room the same totals plus rated cooling against the IT load and a least-squares trend of the daily average draw
// over the last CAPACITY.trendDays, with the days left to the warning and critical lines. Everything is derived from
// stored CIs, relationships and ClickHouse samples through the contract's capacity arithmetic; nothing is estimated
// where no sample exists (a rack without a reading has a null percent and an unknown state).
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { BSM, CAPACITY, POWER, TIME } from '@openmap/constants';
import {
  COOLING_ATTRIBUTES,
  DCIM_ATTRIBUTES,
  PORT_ATTRIBUTES,
  PORT_DEVICE_TYPES,
  POWER_METRICS,
  capacityState,
  daysUntil,
  freeBlocks,
  linearTrend,
  usedPercent,
  worstCapacityState,
  type CapacityState,
  type TrendPoint,
} from '@openmap/contracts';
import { withSpan } from '@openmap/telemetry';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord } from '../ci/ci.types.js';
import { stringAttribute } from '../common/validation.js';
import { ClickHouseService, clickhouseTime } from '../db/clickhouse.service.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { DcimService, LOCATED_IN, firstNumber, type RackView } from './dcim.service.js';

const COOLED_BY = 'cooled_by';
const CONTAINS = 'contains';

export interface SpaceCapacityView {
  units: number;
  occupied: number;
  free: number;
  largestFreeBlock: number;
  freeBlocks: number[];
  percent: number | null;
}

export interface PowerCapacityView {
  designWatts: number;
  loadWatts: number;
  percent: number | null;
  state: CapacityState;
  measuredAt: string | null;
}

export interface PortCapacityView {
  total: number;
  used: number;
  free: number;
  percent: number | null;
}

export interface CoolingCapacityView {
  capacityKw: number;
  loadKw: number;
  percent: number | null;
  state: CapacityState;
  units: number;
}

export interface CapacityTrendView {
  days: number;
  points: number;
  slopeKwPerDay: number | null;
  daysToWarning: number | null;
  daysToCritical: number | null;
}

export interface RackCapacityView {
  rackId: string;
  space: SpaceCapacityView;
  power: PowerCapacityView;
  ports: PortCapacityView;
  state: CapacityState;
}

export interface RoomCapacityView {
  roomId: string;
  racks: RackCapacityView[];
  space: SpaceCapacityView;
  power: PowerCapacityView;
  cooling: CoolingCapacityView;
  ports: PortCapacityView;
  trend: CapacityTrendView;
  state: CapacityState;
}

interface LatestRow {
  ci: string;
  value: number;
  ts_ms: string | number;
}

interface DailyRow {
  d: string;
  ci: string;
  value: number;
}

function stateOf(percent: number | null): CapacityState {
  return capacityState(percent, CAPACITY.warnPercent, CAPACITY.criticalPercent);
}

function isPortDevice(ci: CiRecord): boolean {
  return (PORT_DEVICE_TYPES as readonly string[]).includes(ci.type);
}

function isUp(iface: CiRecord): boolean {
  for (const name of PORT_ATTRIBUTES.operStatus) {
    const value = stringAttribute(iface.attributes, name);
    if (value !== null) return (PORT_ATTRIBUTES.upValues as readonly string[]).includes(value.toLowerCase());
  }
  return false;
}

function spaceOf(rack: RackView): SpaceCapacityView {
  const blocks = freeBlocks(
    rack.units,
    rack.devices.map((d) => ({ start: d.startUnit, height: d.heightUnits })),
  );
  const free = blocks.reduce((n, b) => n + b.height, 0);
  const occupied = Math.max(0, rack.units - free);
  return {
    units: rack.units,
    occupied,
    free,
    largestFreeBlock: blocks.reduce((m, b) => Math.max(m, b.height), 0),
    freeBlocks: blocks.map((b) => b.height),
    percent: usedPercent(occupied, rack.units),
  };
}

function sumSpace(parts: readonly SpaceCapacityView[]): SpaceCapacityView {
  const units = parts.reduce((n, p) => n + p.units, 0);
  const occupied = parts.reduce((n, p) => n + p.occupied, 0);
  return {
    units,
    occupied,
    free: units - occupied,
    largestFreeBlock: parts.reduce((m, p) => Math.max(m, p.largestFreeBlock), 0),
    freeBlocks: parts.flatMap((p) => p.freeBlocks),
    percent: usedPercent(occupied, units),
  };
}

function sumPorts(parts: readonly PortCapacityView[]): PortCapacityView {
  const total = parts.reduce((n, p) => n + p.total, 0);
  const used = parts.reduce((n, p) => n + p.used, 0);
  return { total, used, free: total - used, percent: usedPercent(used, total) };
}

@Injectable()
export class CapacityService {
  constructor(
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly dcim: DcimService,
    private readonly clickhouse: ClickHouseService,
    private readonly metrics: MetricsService,
  ) {}

  /** Latest PDU draw per CI from the latest-sample table, in watts, with the sample's instant. */
  private async latestWatts(
    tenantId: string,
    ids: readonly string[],
  ): Promise<Map<string, { watts: number; at: number }>> {
    const out = new Map<string, { watts: number; at: number }>();
    for (let i = 0; i < ids.length; i += CAPACITY.trendIdBatch) {
      const rows = await this.clickhouse.query<LatestRow>(
        'capacity_latest',
        'SELECT toString(ci_id) AS ci, argMax(value, ts) AS value, toUnixTimestamp64Milli(max(ts)) AS ts_ms FROM ' +
          this.clickhouse.database +
          '.metrics_latest WHERE tenant_id = {tenantId:UUID} AND metric = {metric:String} AND ci_id IN ({ids:Array(UUID)}) GROUP BY ci_id',
        { tenantId, metric: POWER_METRICS.pdu, ids: ids.slice(i, i + CAPACITY.trendIdBatch) },
      );
      for (const r of rows) out.set(r.ci, { watts: r.value, at: Number(r.ts_ms) });
    }
    return out;
  }

  /** The room's draw per day over the trend window: each PDU's daily average, summed across PDUs, in kW. */
  private async dailyLoadKw(tenantId: string, ids: readonly string[], now: Date): Promise<TrendPoint[]> {
    const from = new Date(now.getTime() - CAPACITY.trendDays * TIME.msPerDay);
    const byDay = new Map<string, number>();
    for (let i = 0; i < ids.length; i += CAPACITY.trendIdBatch) {
      const rows = await this.clickhouse.query<DailyRow>(
        'capacity_daily',
        'SELECT toString(toDate(ts)) AS d, toString(ci_id) AS ci, avg(value) AS value FROM ' +
          this.clickhouse.database +
          '.metrics WHERE tenant_id = {tenantId:UUID} AND metric = {metric:String} AND ci_id IN ({ids:Array(UUID)}) AND ts >= toDateTime64({from:String}, 3) AND ts <= toDateTime64({to:String}, 3) GROUP BY d, ci ORDER BY d',
        {
          tenantId,
          metric: POWER_METRICS.pdu,
          ids: ids.slice(i, i + CAPACITY.trendIdBatch),
          from: clickhouseTime(from),
          to: clickhouseTime(now),
        },
      );
      for (const r of rows) byDay.set(r.d, (byDay.get(r.d) ?? 0) + r.value / POWER.wattsPerKilowatt);
    }
    return [...byDay.entries()]
      .map(([d, kw]) => ({ at: Date.parse(d + 'T00:00:00.000Z'), value: kw }))
      .sort((a, b) => a.at - b.at);
  }

  async room(tenantId: string, roomId: string, now: Date = new Date()): Promise<RoomCapacityView> {
    return withSpan(TRACER_NAME, 'dcim.capacity.room', { 'openmap.tenant': tenantId }, async () => {
      const [room] = await this.cis.findByIds(tenantId, [roomId]);
      if (room === undefined || room.type !== 'room')
        throw new NotFoundException('room ' + roomId + ' not found');
      const racks = await this.dcim.racks(tenantId, roomId);
      const rackIds = racks.map((r) => r.ci.id);
      const pduOfRack = new Map(racks.map((r) => [r.ci.id, r.powerFeeds.filter((f) => f.ci.type === 'pdu')]));
      const pduIds = [...pduOfRack.values()].flat().map((f) => f.ci.id);
      const portDevices = racks.flatMap((r) =>
        r.devices.filter((d) => isPortDevice(d.ci)).map((d) => ({ rackId: r.ci.id, ci: d.ci })),
      );
      const [latest, daily, contained, inRoom, cooledBy] = await Promise.all([
        this.latestWatts(tenantId, pduIds),
        this.dailyLoadKw(tenantId, pduIds, now),
        portDevices.length
          ? this.cis.relationshipsOfMany(
              tenantId,
              portDevices.map((d) => d.ci.id),
              [CONTAINS],
              'downstream',
            )
          : Promise.resolve([]),
        this.cis.relationshipsOfMany(tenantId, [roomId], [LOCATED_IN], 'upstream'),
        rackIds.length
          ? this.cis.relationshipsOfMany(tenantId, rackIds, [COOLED_BY], 'downstream')
          : Promise.resolve([]),
      ]);
      const interfaces = (
        await this.cis.findByIds(
          tenantId,
          contained.map((r) => r.toCiId),
        )
      ).filter((c) => c.type === 'interface' && c.validTo === null);
      const interfacesOf = new Map<string, CiRecord[]>();
      for (const rel of contained) {
        const iface = interfaces.find((c) => c.id === rel.toCiId);
        if (iface !== undefined)
          interfacesOf.set(rel.fromCiId, [...(interfacesOf.get(rel.fromCiId) ?? []), iface]);
      }
      const coolingUnits = (
        await this.cis.findByIds(tenantId, [
          ...new Set([...inRoom.map((r) => r.fromCiId), ...cooledBy.map((r) => r.toCiId)]),
        ])
      ).filter((c) => c.type === 'cooling_unit' && c.validTo === null);

      const rackViews: RackCapacityView[] = racks.map((rack) => {
        const space = spaceOf(rack);
        const pdus = pduOfRack.get(rack.ci.id) ?? [];
        const designKw = firstNumber(rack.ci.attributes, DCIM_ATTRIBUTES.designKw);
        const designWatts = Math.round(
          designKw !== null ? designKw * POWER.wattsPerKilowatt : pdus.reduce((n, f) => n + f.ratedWatts, 0),
        );
        let loadWatts = 0;
        let measured = false;
        let measuredAt: number | null = null;
        for (const f of pdus) {
          const sample = latest.get(f.ci.id);
          if (sample !== undefined) {
            loadWatts += sample.watts;
            measured = true;
            measuredAt = measuredAt === null ? sample.at : Math.max(measuredAt, sample.at);
          } else if (f.currentWatts > 0) {
            loadWatts += f.currentWatts;
            measured = true;
          }
        }
        const powerPercent = measured ? usedPercent(loadWatts, designWatts) : null;
        const power: PowerCapacityView = {
          designWatts,
          loadWatts: Math.round(loadWatts),
          percent: powerPercent,
          state: stateOf(powerPercent),
          measuredAt: measuredAt === null ? null : new Date(measuredAt).toISOString(),
        };
        const devices = portDevices.filter((d) => d.rackId === rack.ci.id);
        let total = 0;
        let used = 0;
        for (const d of devices) {
          const ifaces = interfacesOf.get(d.ci.id) ?? [];
          total += Math.max(firstNumber(d.ci.attributes, PORT_ATTRIBUTES.portCount) ?? 0, ifaces.length);
          used += ifaces.filter(isUp).length;
        }
        const ports: PortCapacityView = {
          total,
          used,
          free: Math.max(0, total - used),
          percent: usedPercent(used, total),
        };
        return {
          rackId: rack.ci.id,
          space,
          power,
          ports,
          state: worstCapacityState([power.state, stateOf(space.percent), stateOf(ports.percent)]),
        };
      });

      const space = sumSpace(rackViews.map((r) => r.space));
      const ports = sumPorts(rackViews.map((r) => r.ports));
      const designWatts = rackViews.reduce((n, r) => n + r.power.designWatts, 0);
      const measuredRacks = rackViews.filter((r) => r.power.percent !== null);
      const loadWatts = rackViews.reduce((n, r) => n + r.power.loadWatts, 0);
      const powerPercent = measuredRacks.length > 0 ? usedPercent(loadWatts, designWatts) : null;
      const measuredAt =
        rackViews
          .map((r) => r.power.measuredAt)
          .filter((a): a is string => a !== null)
          .sort()
          .at(-1) ?? null;
      const power: PowerCapacityView = {
        designWatts,
        loadWatts,
        percent: powerPercent,
        state: stateOf(powerPercent),
        measuredAt,
      };
      const capacityKw = coolingUnits.reduce(
        (n, u) => n + (firstNumber(u.attributes, COOLING_ATTRIBUTES.capacityKw) ?? 0),
        0,
      );
      const loadKw = loadWatts / POWER.wattsPerKilowatt;
      const coolingPercent =
        measuredRacks.length > 0 && capacityKw > 0 ? usedPercent(loadKw, capacityKw) : null;
      const cooling: CoolingCapacityView = {
        capacityKw,
        loadKw,
        percent: coolingPercent,
        state: stateOf(coolingPercent),
        units: coolingUnits.length,
      };
      const fit = linearTrend(daily, CAPACITY.trendMinPoints, TIME.msPerDay);
      const designKw = designWatts / POWER.wattsPerKilowatt;
      const trend: CapacityTrendView = {
        days: CAPACITY.trendDays,
        points: daily.length,
        slopeKwPerDay: fit?.slopePerDay ?? null,
        daysToWarning:
          fit === null || designKw <= 0
            ? null
            : daysUntil(loadKw, fit.slopePerDay, (designKw * CAPACITY.warnPercent) / BSM.percentScale),
        daysToCritical:
          fit === null || designKw <= 0
            ? null
            : daysUntil(loadKw, fit.slopePerDay, (designKw * CAPACITY.criticalPercent) / BSM.percentScale),
      };
      this.metrics.capacityReads.inc();
      return {
        roomId,
        racks: rackViews,
        space,
        power,
        cooling,
        ports,
        trend,
        state: worstCapacityState([
          power.state,
          cooling.state,
          stateOf(space.percent),
          stateOf(ports.percent),
        ]),
      };
    });
  }
}
