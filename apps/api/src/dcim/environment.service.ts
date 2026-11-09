// REQ-DCIM-006 (ADR-060) — a room's environment over a window: each rack's inlet and outlet temperature (the rack's own
// sensors, or a probe on one of its PDUs, by the sample's `position` label), the rise across it, its inlet series and
// its state against the ASHRAE A1 envelope and the airflow rule; the room's humidity; each cooling unit's supply and
// return air, humidity and capacity in use. A reading older than ENVIRONMENT.freshMs is shown but not judged.
import { Inject, Injectable } from '@nestjs/common';
import { ENVIRONMENT, POWER, TIME, UTILISATION } from '@openmap/constants';
import { ENV_METRICS, airflowState, humidityState, temperatureState, worstState, type EnvState } from '@openmap/contracts';
import { withSpan } from '@openmap/telemetry';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import { ClickHouseService, clickhouseTime } from '../db/clickhouse.service.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { DcimService, LOCATED_IN } from './dcim.service.js';

const COOLED_BY = 'cooled_by';

export interface EnvReadingView {
  at: string;
  value: number;
}

export interface RackEnvironmentView {
  rackId: string;
  inletC: number | null;
  outletC: number | null;
  riseC: number | null;
  latestAt: string | null;
  temperatureState: EnvState;
  airflowState: EnvState;
  state: EnvState;
  inletSeries: EnvReadingView[];
}

export interface CoolingEnvironmentView {
  unitId: string;
  supplyC: number | null;
  returnC: number | null;
  humidityRh: number | null;
  capacityPercent: number | null;
  state: EnvState;
}

export interface RoomEnvironmentView {
  humidityRh: number | null;
  humidityState: EnvState;
  racks: RackEnvironmentView[];
  coolingUnits: CoolingEnvironmentView[];
  summary: { racks: number; normal: number; warning: number; critical: number; unknown: number; hottestInletC: number | null };
}

interface SampleRow {
  env_ci: string;
  metric: string;
  pos: string;
  ts_ms: string | number;
  value: number;
}

interface Reading {
  at: number;
  value: number;
}

@Injectable()
export class EnvironmentService {
  constructor(
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly dcim: DcimService,
    private readonly clickhouse: ClickHouseService,
    private readonly metrics: MetricsService,
  ) {}

  /** Readings by CI, metric and position over the window, in id batches inside ClickHouse's parameter cap. */
  private async readings(tenantId: string, ids: readonly string[], from: Date, to: Date): Promise<Map<string, Reading[]>> {
    const out = new Map<string, Reading[]>();
    for (let i = 0; i < ids.length; i += POWER.monitorIdBatch) {
      const rows = await this.clickhouse.query<SampleRow>(
        'environment_samples',
        "SELECT toString(ci_id) AS env_ci, metric, labels['position'] AS pos, toUnixTimestamp64Milli(ts) AS ts_ms, value FROM " +
          this.clickhouse.database +
          '.metrics WHERE tenant_id = {tenantId:UUID} AND ci_id IN ({ids:Array(UUID)}) AND metric IN ({metrics:Array(String)}) AND ts >= toDateTime64({from:String}, 3) AND ts <= toDateTime64({to:String}, 3) ORDER BY ts',
        { tenantId, ids: ids.slice(i, i + POWER.monitorIdBatch), metrics: Object.values(ENV_METRICS), from: clickhouseTime(from), to: clickhouseTime(to) },
      );
      for (const r of rows) {
        const key = r.env_ci + '|' + r.metric + '|' + r.pos;
        out.set(key, [...(out.get(key) ?? []), { at: Number(r.ts_ms), value: r.value }]);
      }
    }
    return out;
  }

  async room(tenantId: string, roomId: string, hours: number, now: Date = new Date()): Promise<RoomEnvironmentView> {
    return withSpan(TRACER_NAME, 'dcim.environment.room', { 'openmap.tenant': tenantId }, async () => {
      const racks = await this.dcim.racks(tenantId, roomId);
      const [inRoom, cooledBy] = await Promise.all([
        this.cis.relationshipsOfMany(tenantId, [roomId], [LOCATED_IN], 'upstream'),
        this.cis.relationshipsOfMany(tenantId, [roomId], [COOLED_BY], 'downstream'),
      ]);
      const units = (await this.cis.findByIds(tenantId, [...new Set([...inRoom.map((r) => r.fromCiId), ...cooledBy.map((r) => r.toCiId)])])).filter((c) => c.type === 'cooling_unit' && c.validTo === null);
      // A rack's probes may sit on its PDUs (ENTITY-SENSOR probes plugged into the PDU), read as the rack's.
      const probesOf = new Map(racks.map((r) => [r.ci.id, [r.ci.id, ...r.powerFeeds.filter((f) => f.ci.type === 'pdu').map((f) => f.ci.id)]]));
      const ids = [roomId, ...units.map((u) => u.id), ...[...probesOf.values()].flat()];
      const from = new Date(now.getTime() - hours * TIME.msPerHour);
      const readings = await this.readings(tenantId, ids, from, now);
      const fresh = (r: Reading | undefined): r is Reading => r !== undefined && now.getTime() - r.at <= ENVIRONMENT.freshMs;
      const series = (ciIds: readonly string[], metric: string, pos: string): Reading[] =>
        ciIds.flatMap((id) => readings.get(id + '|' + metric + '|' + pos) ?? []).sort((a, b) => a.at - b.at);
      const bucketMs = Math.max(1, Math.ceil((hours * TIME.msPerHour) / UTILISATION.seriesPoints));

      const rackViews: RackEnvironmentView[] = racks.map((rack) => {
        const probes = probesOf.get(rack.ci.id) ?? [rack.ci.id];
        const inlet = series(probes, ENV_METRICS.temperature, 'inlet');
        const outlet = series(probes, ENV_METRICS.temperature, 'outlet');
        const lastIn = inlet.at(-1);
        const lastOut = outlet.at(-1);
        const inletC = lastIn?.value ?? null;
        const outletC = lastOut?.value ?? null;
        const temperature = fresh(lastIn) ? temperatureState(inletC) : 'unknown';
        const airflow = fresh(lastIn) && fresh(lastOut) ? airflowState(inletC, outletC) : 'unknown';
        const buckets = new Map<number, number[]>();
        for (const r of inlet) {
          const b = Math.floor(r.at / bucketMs) * bucketMs;
          buckets.set(b, [...(buckets.get(b) ?? []), r.value]);
        }
        return {
          rackId: rack.ci.id,
          inletC,
          outletC,
          riseC: inletC === null || outletC === null ? null : outletC - inletC,
          latestAt: lastIn === undefined ? null : new Date(lastIn.at).toISOString(),
          temperatureState: temperature,
          airflowState: airflow,
          state: worstState([temperature, airflow]),
          inletSeries: [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([at, v]) => ({ at: new Date(at).toISOString(), value: v.reduce((x, y) => x + y, 0) / v.length })),
        };
      });

      const latest = (id: string, metric: string, pos: string): Reading | undefined => series([id], metric, pos).at(-1);
      const roomRh = latest(roomId, ENV_METRICS.humidity, 'room');
      const coolingUnits: CoolingEnvironmentView[] = units.map((u) => {
        const rh = latest(u.id, ENV_METRICS.humidity, 'return');
        return {
          unitId: u.id,
          supplyC: latest(u.id, ENV_METRICS.temperature, 'supply')?.value ?? null,
          returnC: latest(u.id, ENV_METRICS.temperature, 'return')?.value ?? null,
          humidityRh: rh?.value ?? null,
          capacityPercent: latest(u.id, ENV_METRICS.coolingCapacity, '')?.value ?? null,
          state: fresh(rh) ? humidityState(rh.value) : 'unknown',
        };
      });
      const count = (s: EnvState): number => rackViews.filter((r) => r.state === s).length;
      const inlets = rackViews.flatMap((r) => (r.inletC === null ? [] : [r.inletC]));
      this.metrics.environmentReads.inc();
      return {
        humidityRh: roomRh?.value ?? null,
        humidityState: fresh(roomRh) ? humidityState(roomRh.value) : 'unknown',
        racks: rackViews,
        coolingUnits,
        summary: { racks: rackViews.length, normal: count('normal'), warning: count('warning'), critical: count('critical'), unknown: count('unknown'), hottestInletC: inlets.length === 0 ? null : Math.max(...inlets) },
      };
    });
  }
}
