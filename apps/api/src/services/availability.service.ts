// REQ-BSM-006 REQ-BSM-008 (ADR-024) — availability of business services from the ClickHouse health history: the
// current SLA window of each service (budget, burn rate), the figures per calendar month, quarter or year in the
// tenant's time zone, the report over every service, and its CSV export. Pure arithmetic comes from @openmap/bsm-engine;
// this service only fetches history and shapes views.
import { Inject, Injectable } from '@nestjs/common';
import {
  HEALTH_HISTORY_TABLE,
  availabilityIn,
  calendarPeriods,
  changesOf,
  createHistoryReader,
  isoOfCh,
  slaWindowAt,
  windowBudget,
  type AvailabilityFigures,
  type CalendarPeriod,
  type HealthChange,
  type HealthHistoryReader,
  type SubjectHealthChange,
  type TimeWindow,
  type WindowBudget,
} from '@openmap/bsm-engine';
import { TENANT_SETTINGS_DEFAULTS } from '@openmap/config';
import { SLA, type AvailabilityGranularity } from '@openmap/constants';
import type { CiRecord, HealthState } from '../ci/ci.types.js';
import { nowIso } from '../common/time.js';
import { numberAttribute } from '../common/validation.js';
import { ClickHouseService } from '../db/clickhouse.service.js';
import { TenantSettingsService } from '../tenant/tenant-settings.service.js';
import { SLA_REPOSITORY, type SlaRepository } from './sla.repository.js';
import type { AvailabilityPeriodView, ServiceAvailabilityView, SlaRecord } from './services.types.js';

/** Attribute a collector or the synthetic estate may carry; the fallback target when no SLA is assigned. */
const TARGET_ATTRIBUTE = 'slaTargetPercent';
const CSV_SEPARATOR = ',';
const CSV_LINE = '\n';
const CSV_QUOTE = '"';
const CSV_HEADER = [
  'service',
  'code',
  'sla',
  'granularity',
  'year',
  'month',
  'quarter',
  'period_start',
  'period_end',
  'availability_percent',
  'target_percent',
  'met',
  'downtime_minutes',
  'degraded_minutes',
  'unknown_minutes',
  'elapsed_minutes',
] as const;

interface HistorySlice {
  changes: SubjectHealthChange[];
  before: Map<string, HealthState>;
}

function periodView(
  serviceCiId: string,
  period: CalendarPeriod | (TimeWindow & { current: boolean }),
  figures: AvailabilityFigures,
  target: number | null,
  budget: WindowBudget | null,
): AvailabilityPeriodView {
  const calendar = 'granularity' in period ? period : null;
  const started = new Date(period.start);
  return {
    granularity: calendar?.granularity ?? null,
    year: calendar?.year ?? started.getUTCFullYear(),
    month: calendar?.month ?? null,
    quarter: calendar?.quarter ?? null,
    periodStart: period.start,
    periodEnd: period.end,
    current: period.current,
    availabilityPercent: figures.availabilityPercent,
    elapsedMinutes: figures.elapsedMinutes,
    downtimeMinutes: figures.downtimeMinutes,
    degradedMinutes: figures.degradedMinutes,
    unknownMinutes: figures.unknownMinutes,
    targetPercent: target,
    met:
      target === null || figures.availabilityPercent === null ? null : figures.availabilityPercent >= target,
    budgetMinutes: budget?.budgetMinutes ?? null,
    budgetRemainingMinutes: budget?.remainingMinutes ?? null,
    burnRate: budget?.burnRate ?? null,
    serviceCiId,
  };
}

function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  if (typeof value === 'number')
    return Number.isInteger(value) ? String(value) : value.toFixed(SLA.percentDecimals);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return CSV_QUOTE + value.replaceAll(CSV_QUOTE, CSV_QUOTE + CSV_QUOTE) + CSV_QUOTE;
}

interface LastChangeRow {
  subject: string;
  at: string;
}

@Injectable()
export class AvailabilityService {
  private readonly history: HealthHistoryReader;

  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly settings: TenantSettingsService,
    @Inject(SLA_REPOSITORY) private readonly slas: SlaRepository,
  ) {
    this.history = createHistoryReader(
      (name, sql, params) => clickhouse.query(name, sql, params),
      clickhouse.database,
    );
  }

  /** When each service last changed state, from the history; services with no row are absent. */
  async lastChanges(tenantId: string, ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.clickhouse.query<LastChangeRow>(
      'health_history_last_change',
      'SELECT toString(service_ci_id) AS subject, toString(max(ts)) AS at FROM ' +
        this.clickhouse.database +
        '.' +
        HEALTH_HISTORY_TABLE +
        ' WHERE tenant_id = {tenantId:UUID} AND service_ci_id IN ({subjects:Array(UUID)}) GROUP BY service_ci_id',
      { tenantId, subjects: [...ids] },
    );
    return new Map(rows.map((r) => [r.subject, isoOfCh(r.at)]));
  }

  /** A window with nothing observed, for a service the history has never seen. */
  emptyWindow(serviceCiId: string, now = nowIso()): AvailabilityPeriodView {
    const window = slaWindowAt('rolling_30d', now, TENANT_SETTINGS_DEFAULTS.timeZone);
    return periodView(
      serviceCiId,
      { ...window, current: true },
      availabilityIn([], 'unknown', window, now),
      null,
      null,
    );
  }

  /** The target a service is measured against: its assigned SLA, else the attribute, else none. */
  static targetOf(service: CiRecord, sla: SlaRecord | null): number | null {
    return sla?.availabilityTargetPercent ?? numberAttribute(service.attributes, TARGET_ATTRIBUTE);
  }

  private async slice(tenantId: string, ids: readonly string[], since: string): Promise<HistorySlice> {
    const [changes, before] = await Promise.all([
      this.history.changes(tenantId, ids, since),
      this.history.stateBefore(tenantId, ids, since),
    ]);
    return { changes, before };
  }

  private initialState(
    slice: HistorySlice,
    serviceId: string,
    live: HealthState | undefined,
    changes: readonly HealthChange[],
  ): HealthState {
    const before = slice.before.get(serviceId);
    if (before !== undefined) return before;
    // No row before the range: the service was healthy until its first recorded change, or carries its live state
    // when nothing was ever recorded (an estate observed once and never changed).
    return changes.length === 0 ? (live ?? 'unknown') : 'healthy';
  }

  /** The SLA window (or the rolling 30 days without an SLA) of each service with its figures and budget, as of now. */
  async currentWindows(
    tenantId: string,
    services: readonly CiRecord[],
    live: ReadonlyMap<string, HealthState>,
    slas: ReadonlyMap<string, SlaRecord>,
    now = nowIso(),
  ): Promise<Map<string, { view: AvailabilityPeriodView; budget: WindowBudget | null }>> {
    const out = new Map<string, { view: AvailabilityPeriodView; budget: WindowBudget | null }>();
    if (services.length === 0) return out;
    const timeZone = (await this.settings.get(tenantId)).timeZone;
    const windows = new Map(
      services.map(
        (s) => [s.id, slaWindowAt(slas.get(s.id)?.window ?? 'rolling_30d', now, timeZone)] as const,
      ),
    );
    const earliest = [...windows.values()].reduce(
      (min, w) => (Date.parse(w.start) < Date.parse(min) ? w.start : min),
      now,
    );
    const slice = await this.slice(
      tenantId,
      services.map((s) => s.id),
      earliest,
    );
    for (const service of services) {
      const window = windows.get(service.id);
      if (window === undefined) continue;
      const changes = changesOf(slice.changes, service.id);
      const figures = availabilityIn(
        changes,
        this.initialState(slice, service.id, live.get(service.id), changes),
        window,
        now,
      );
      const target = AvailabilityService.targetOf(service, slas.get(service.id) ?? null);
      const budget = target === null ? null : windowBudget(target, window, figures, now);
      out.set(service.id, {
        view: periodView(
          service.id,
          { ...window, current: Date.parse(window.end) > Date.parse(now) },
          figures,
          target,
          budget,
        ),
        budget,
      });
    }
    return out;
  }

  /** Figures per calendar period (oldest first, the current one last) for each service. */
  async periods(
    tenantId: string,
    services: readonly CiRecord[],
    live: ReadonlyMap<string, HealthState>,
    granularity: AvailabilityGranularity,
    count: number | null,
    now = nowIso(),
  ): Promise<ServiceAvailabilityView[]> {
    if (services.length === 0) return [];
    const timeZone = (await this.settings.get(tenantId)).timeZone;
    const periods = calendarPeriods(granularity, count ?? SLA.defaultPeriods[granularity], now, timeZone);
    const first = periods[0];
    if (first === undefined) return [];
    const ids = services.map((s) => s.id);
    const [slice, slas] = await Promise.all([
      this.slice(tenantId, ids, first.start),
      this.slas.assignedTo(tenantId, ids),
    ]);
    return services.map((service) => {
      const sla = slas.get(service.id) ?? null;
      const target = AvailabilityService.targetOf(service, sla);
      const changes = changesOf(slice.changes, service.id);
      const initial = this.initialState(slice, service.id, live.get(service.id), changes);
      return {
        service,
        sla,
        periods: periods.map((period) => {
          const figures = availabilityIn(changes, initial, period, now);
          return periodView(
            service.id,
            period,
            figures,
            target,
            target === null ? null : windowBudget(target, period, figures, now),
          );
        }),
      };
    });
  }

  /** CSV of the report: one row per service and period, numbers to SLA.percentDecimals. */
  static toCsv(report: readonly ServiceAvailabilityView[]): string {
    const lines: string[] = [CSV_HEADER.join(CSV_SEPARATOR)];
    for (const row of report) {
      for (const p of row.periods) {
        lines.push(
          [
            row.service.displayName,
            row.service.code,
            row.sla?.name ?? null,
            p.granularity,
            p.year,
            p.month,
            p.quarter,
            p.periodStart,
            p.periodEnd,
            p.availabilityPercent,
            p.targetPercent,
            p.met,
            p.downtimeMinutes,
            p.degradedMinutes,
            p.unknownMinutes,
            p.elapsedMinutes,
          ]
            .map(csvCell)
            .join(CSV_SEPARATOR),
        );
      }
    }
    return lines.join(CSV_LINE) + CSV_LINE;
  }
}
