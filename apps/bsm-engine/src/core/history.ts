// REQ-BSM-006 REQ-BSM-008 (ADR-024) — the service health history in ClickHouse: the one source of availability.
// The SQL and row mapping live here so the engine (its own client) and the API (its instrumented ClickHouseService)
// read the same table the same way; the caller supplies the function that runs a parameterised query.
import { HEALTH_STATES } from '@openmap/contracts';
import type { Health } from './propagate.js';

export const HEALTH_HISTORY_TABLE = 'service_health_history';

export interface SubjectHealthChange {
  subject: string;
  at: string;
  state: Health;
}

export interface HealthHistoryReader {
  /** Changes of the subjects at or after `since`, oldest first. */
  changes(tenantId: string, subjects: readonly string[], since: string): Promise<SubjectHealthChange[]>;
  /** Latest state of each subject strictly before `before`; subjects with no row are absent. */
  stateBefore(tenantId: string, subjects: readonly string[], before: string): Promise<Map<string, Health>>;
}

export type QueryParams = Record<string, string | number | boolean | readonly string[] | readonly number[]>;
export type RunQuery = <Row>(name: string, sql: string, params: QueryParams) => Promise<Row[]>;

const ISO_T = 'T';
const ISO_Z = 'Z';
const CH_SEPARATOR = ' ';
/** chDateTime renders instants in UTC; the cast names the zone so the server's default never applies. */
const UTC_ZONE = 'UTC';

/** ClickHouse DateTime64(3) literal of an ISO instant: `YYYY-MM-DD hh:mm:ss.mmm` in UTC. */
export function chDateTime(iso: string): string {
  return new Date(iso).toISOString().replace(ISO_T, CH_SEPARATOR).replace(ISO_Z, '');
}

/** ISO instant of a ClickHouse DateTime64 string rendered by JSONEachRow. */
export function isoOfCh(ts: string): string {
  return ts.includes(ISO_T)
    ? new Date(ts).toISOString()
    : new Date(ts.replace(CH_SEPARATOR, ISO_T) + ISO_Z).toISOString();
}

interface ChangeRow {
  subject: string;
  state: string;
  /** Aliased away from `ts` so the WHERE clause keeps binding to the DateTime64 column. */
  at: string;
}

interface StateRow {
  subject: string;
  state: string;
}

const STATES: ReadonlySet<string> = new Set(HEALTH_STATES);

function toHealth(state: string): Health | null {
  return STATES.has(state) ? (state as Health) : null;
}

export function changesQuery(database: string): string {
  return (
    'SELECT toString(service_ci_id) AS subject, health AS state, toString(ts) AS at FROM ' +
    database +
    '.' +
    HEALTH_HISTORY_TABLE +
    ' WHERE tenant_id = {tenantId:UUID} AND service_ci_id IN ({subjects:Array(UUID)}) AND ts >= toDateTime64({since:String}, 3, {zone:String}) ORDER BY ts, service_ci_id'
  );
}

export function stateBeforeQuery(database: string): string {
  return (
    'SELECT toString(service_ci_id) AS subject, argMax(health, ts) AS state FROM ' +
    database +
    '.' +
    HEALTH_HISTORY_TABLE +
    ' WHERE tenant_id = {tenantId:UUID} AND service_ci_id IN ({subjects:Array(UUID)}) AND ts < toDateTime64({before:String}, 3, {zone:String}) GROUP BY service_ci_id'
  );
}

export function createHistoryReader(run: RunQuery, database: string): HealthHistoryReader {
  return {
    async changes(tenantId, subjects, since) {
      if (subjects.length === 0) return [];
      const rows = await run<ChangeRow>('health_history_changes', changesQuery(database), {
        tenantId,
        subjects: [...subjects],
        since: chDateTime(since),
        zone: UTC_ZONE,
      });
      const out: SubjectHealthChange[] = [];
      for (const r of rows) {
        const state = toHealth(r.state);
        if (state !== null) out.push({ subject: r.subject, at: isoOfCh(r.at), state });
      }
      return out;
    },
    async stateBefore(tenantId, subjects, before) {
      const out = new Map<string, Health>();
      if (subjects.length === 0) return out;
      const rows = await run<StateRow>('health_history_state_before', stateBeforeQuery(database), {
        tenantId,
        subjects: [...subjects],
        before: chDateTime(before),
        zone: UTC_ZONE,
      });
      for (const r of rows) {
        const state = toHealth(r.state);
        if (state !== null) out.set(r.subject, state);
      }
      return out;
    },
  };
}
