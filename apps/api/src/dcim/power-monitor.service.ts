// REQ-DCIM-005 (ADR-059) — power monitoring, thresholds and billing by outlet for a room:
// - each PDU's measured draw over the window (averaged into the series the screen draws), its latest reading and state
//   against the tenant's warning and critical lines, its peak and the energy it delivered;
// - each metered outlet's energy (the `power_feed` CI the PDU contains), the device on it (the cord whose outlet number
//   is the outlet's index) and, with a tariff, its cost; per device, the sum over its outlets and its owning cost
//   centre (the asset register's), so energy can be billed back.
// Energy is integrated between measured samples only (`energyOf`); nothing outside the samples is estimated.
import { Inject, Injectable } from '@nestjs/common';
import { DCIM, POWER, TIME, UTILISATION } from '@openmap/constants';
import { POWER_ATTRIBUTES as P, POWER_METRICS, energyOf, powerState, type PowerSettings, type PowerState, type WattSample } from '@openmap/contracts';
import { withSpan } from '@openmap/telemetry';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import { numberAttribute, stringAttribute } from '../common/validation.js';
import { ClickHouseService, clickhouseTime } from '../db/clickhouse.service.js';
import { PrismaService } from '../db/prisma.service.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { DcimService, POWERED_BY } from './dcim.service.js';

const CONTAINS = 'contains';
const OUTLET_INDEX = 'outletIndex';

export interface PowerReadingView {
  at: string;
  watts: number;
}

export interface PduMonitorView {
  pduId: string;
  rackId: string | null;
  feed: string | null;
  ratedWatts: number | null;
  latestWatts: number | null;
  latestAt: string | null;
  state: PowerState;
  peakWatts: number | null;
  series: PowerReadingView[];
  energyKwh: number;
  coveredHours: number;
  cost: number | null;
}

export interface OutletBillView {
  outletId: string;
  pduId: string;
  outletIndex: string | null;
  deviceId: string | null;
  energyKwh: number;
  coveredHours: number;
  cost: number | null;
}

export interface DeviceBillView {
  deviceId: string;
  costCentreId: string | null;
  outlets: number;
  energyKwh: number;
  cost: number | null;
}

export interface PowerMonitorView {
  settings: PowerSettings;
  hours: number;
  pdus: PduMonitorView[];
  outlets: OutletBillView[];
  devices: DeviceBillView[];
  totalKwh: number;
  totalCost: number | null;
}

interface SampleRow {
  sample_ci: string;
  ts_ms: string | number;
  value: number;
}

function costOf(kwh: number, settings: PowerSettings): number | null {
  return settings.tariffPerKwh === null ? null : kwh * settings.tariffPerKwh;
}

@Injectable()
export class PowerMonitorService {
  constructor(
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly dcim: DcimService,
    private readonly clickhouse: ClickHouseService,
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly metrics: MetricsService,
  ) {}

  async settings(tenantId: string): Promise<PowerSettings> {
    const row = await this.prisma.client.powerSettings.findUnique({ where: { tenantId } });
    if (row === null) return { warnPercent: DCIM.warnPowerPercent, criticalPercent: DCIM.criticalPowerPercent, tariffPerKwh: null, currency: null };
    return { warnPercent: row.warnPercent, criticalPercent: row.criticalPercent, tariffPerKwh: row.tariffPerKwh === null ? null : Number(row.tariffPerKwh), currency: row.currency };
  }

  async updateSettings(tenantId: string, actor: string, input: PowerSettings): Promise<PowerSettings> {
    await this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const data = { warnPercent: input.warnPercent, criticalPercent: input.criticalPercent, tariffPerKwh: input.tariffPerKwh, currency: input.currency, updatedBy: actor };
      await tx.powerSettings.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
      await emit({ type: 'openmap.audit.action', subject: tenantId, data: { action: 'dcim.power.settings.saved', ...data, by: actor } });
    });
    this.metrics.powerSettingsChanges.inc();
    return this.settings(tenantId);
  }

  /** Raw samples of the CIs over the window, in id chunks that keep each query under ClickHouse's parameter size cap. */
  private async samples(tenantId: string, ids: readonly string[], from: Date, to: Date): Promise<Map<string, WattSample[]>> {
    const out = new Map<string, WattSample[]>();
    for (let i = 0; i < ids.length; i += POWER.monitorIdBatch) {
      const rows = await this.clickhouse.query<SampleRow>(
        'power_samples',
        'SELECT toString(ci_id) AS sample_ci, toUnixTimestamp64Milli(ts) AS ts_ms, value FROM ' +
          this.clickhouse.database +
          '.metrics WHERE tenant_id = {tenantId:UUID} AND ci_id IN ({ids:Array(UUID)}) AND metric IN ({metrics:Array(String)}) AND ts >= toDateTime64({from:String}, 3) AND ts <= toDateTime64({to:String}, 3) ORDER BY ts',
        { tenantId, ids: ids.slice(i, i + POWER.monitorIdBatch), metrics: [POWER_METRICS.pdu, POWER_METRICS.outlet], from: clickhouseTime(from), to: clickhouseTime(to) },
      );
      for (const r of rows) out.set(r.sample_ci, [...(out.get(r.sample_ci) ?? []), { at: Number(r.ts_ms), watts: r.value }]);
    }
    return out;
  }

  async monitor(tenantId: string, roomId: string, hours: number, now: Date = new Date()): Promise<PowerMonitorView> {
    return withSpan(TRACER_NAME, 'dcim.power.monitor', { 'openmap.tenant': tenantId }, async () => {
      const settings = await this.settings(tenantId);
      const racks = await this.dcim.racks(tenantId, roomId);
      const pdus = racks.flatMap((r) => r.powerFeeds.filter((f) => f.ci.type === 'pdu').map((f) => ({ feed: f, rackId: r.ci.id })));
      const pduIds = pdus.map((p) => p.feed.ci.id);
      const [contained, cords] = await Promise.all([
        this.cis.relationshipsOfMany(tenantId, pduIds, [CONTAINS], 'downstream'),
        this.cis.relationshipsOfMany(tenantId, pduIds, [POWERED_BY], 'upstream'),
      ]);
      const outletCis = (await this.cis.findByIds(tenantId, contained.map((r) => r.toCiId))).filter((c) => c.type === 'power_feed' && c.validTo === null);
      // A device on an outlet: `powered_by` the outlet itself (as the SNMP outlets are modelled), or a cord to the PDU
      // carrying the outlet's number (as an operator records it, REQ-DCIM-004).
      const onOutlet = await this.cis.relationshipsOfMany(tenantId, outletCis.map((o) => o.id), [POWERED_BY], 'upstream');
      const deviceOfOutlet = new Map(onOutlet.map((r) => [r.toCiId, r.fromCiId]));
      const pduOfOutlet = new Map(contained.map((r) => [r.toCiId, r.fromCiId]));
      const deviceOn = new Map<string, string>();
      for (const c of cords) {
        const outlet = numberAttribute(c.attributes, P.outlet);
        if (outlet !== null) deviceOn.set(c.toCiId + '|' + String(outlet), c.fromCiId);
      }
      const from = new Date(now.getTime() - hours * TIME.msPerHour);
      const series = await this.samples(tenantId, [...pduIds, ...outletCis.map((o) => o.id)], from, now);
      const bucketMs = Math.max(1, Math.ceil((hours * TIME.msPerHour) / UTILISATION.seriesPoints));

      const pduViews: PduMonitorView[] = pdus.map(({ feed, rackId }) => {
        const points = series.get(feed.ci.id) ?? [];
        const last = points.at(-1);
        const rated = feed.ratedWatts > 0 ? feed.ratedWatts : null;
        const latestWatts = last?.watts ?? null;
        const buckets = new Map<number, number[]>();
        for (const s of points) {
          const b = Math.floor(s.at / bucketMs) * bucketMs;
          buckets.set(b, [...(buckets.get(b) ?? []), s.watts]);
        }
        const energy = energyOf(points, from.getTime(), now.getTime());
        return {
          pduId: feed.ci.id,
          rackId,
          feed: stringAttribute(feed.ci.attributes, P.feed),
          ratedWatts: rated,
          latestWatts,
          latestAt: last === undefined ? null : new Date(last.at).toISOString(),
          state: powerState(latestWatts, rated, settings),
          peakWatts: points.length === 0 ? null : Math.max(...points.map((s) => s.watts)),
          series: [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([at, w]) => ({ at: new Date(at).toISOString(), watts: w.reduce((x, y) => x + y, 0) / w.length })),
          energyKwh: energy.kwh,
          coveredHours: energy.coveredHours,
          cost: costOf(energy.kwh, settings),
        };
      });

      const outlets: OutletBillView[] = outletCis.map((o) => {
        const pduId = pduOfOutlet.get(o.id) ?? '';
        const index = stringAttribute(o.attributes, OUTLET_INDEX);
        const energy = energyOf(series.get(o.id) ?? [], from.getTime(), now.getTime());
        return { outletId: o.id, pduId, outletIndex: index, deviceId: deviceOfOutlet.get(o.id) ?? (index === null ? null : (deviceOn.get(pduId + '|' + index) ?? null)), energyKwh: energy.kwh, coveredHours: energy.coveredHours, cost: costOf(energy.kwh, settings) };
      });
      outlets.sort((a, b) => a.pduId.localeCompare(b.pduId) || Number(a.outletIndex) - Number(b.outletIndex));

      const byDevice = new Map<string, { outlets: number; kwh: number }>();
      for (const o of outlets) {
        if (o.deviceId === null) continue;
        const d = byDevice.get(o.deviceId) ?? { outlets: 0, kwh: 0 };
        byDevice.set(o.deviceId, { outlets: d.outlets + 1, kwh: d.kwh + o.energyKwh });
      }
      const owners = await this.prisma.client.assetRecord.findMany({ where: { tenantId, ciId: { in: [...byDevice.keys()] } }, select: { ciId: true, ownerCostCentreCiId: true } });
      const ownerOf = new Map(owners.map((a) => [a.ciId ?? '', a.ownerCostCentreCiId]));
      const devices: DeviceBillView[] = [...byDevice.entries()]
        .map(([deviceId, d]) => ({ deviceId, costCentreId: ownerOf.get(deviceId) ?? null, outlets: d.outlets, energyKwh: d.kwh, cost: costOf(d.kwh, settings) }))
        .sort((a, b) => b.energyKwh - a.energyKwh);
      const totalKwh = pduViews.reduce((sum, p) => sum + p.energyKwh, 0);
      this.metrics.powerMonitorReads.inc();
      return { settings, hours, pdus: pduViews, outlets, devices, totalKwh, totalCost: costOf(totalKwh, settings) };
    });
  }
}
