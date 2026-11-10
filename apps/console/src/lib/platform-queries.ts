// REQ-PERF-005 (ADR-071) — the platform's own health (administrators): one `platformHealth` read per window, refreshed
// on Prometheus's scrape interval so a screen left open follows the stack.
import { queryOptions } from '@tanstack/react-query';
import { PLATFORM_HEALTH, type PlatformWindowMinutes } from '@openmap/constants';
import type { PerfBudgetCheck } from '@openmap/contracts';
import { gql } from './graphql';

export type TargetHealth = 'up' | 'down' | 'unknown';
export type SliStatus = 'ok' | 'breach' | 'no_data';
export type SliUnit = 'count' | 'seconds' | 'ratio';
export type SliId =
  | 'targets_down'
  | 'stores_down'
  | 'openbao_sealed'
  | 'graphql_p95_seconds'
  | 'graphql_error_ratio'
  | 'http_error_ratio'
  | 'event_loop_lag_p99_seconds'
  | 'outbox_oldest_pending_seconds'
  | 'queue_waiting_jobs'
  | 'backup_age_seconds';

export interface PlatformTarget {
  service: string;
  job: string;
  instance: string;
  health: TargetHealth;
  lastScrapeAt: string | null;
  scrapeDurationMs: number | null;
  lastError: string | null;
  requestRate: number | null;
  p95Ms: number | null;
  errorRatio: number | null;
  eventLoopP99Ms: number | null;
  residentBytes: number | null;
  cpuCores: number | null;
}

export interface PlatformStore {
  store: string;
  up: boolean | null;
  probeMs: number | null;
}

export interface PlatformQueue {
  queue: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface PlatformSli {
  id: SliId;
  unit: SliUnit;
  value: number | null;
  objective: number;
  status: SliStatus;
}

export interface PlatformAlert {
  name: string;
  sli: SliId | null;
  severity: string;
  state: 'firing' | 'pending';
  subject: string | null;
  activeAt: string | null;
  value: number | null;
}

export interface PlatformHealth {
  observedAt: string;
  windowMinutes: number;
  prometheus: { reachable: boolean; version: string | null; error: string | null };
  targets: PlatformTarget[];
  stores: PlatformStore[];
  outbox: { pending: number | null; oldestAgeSeconds: number | null; deliveredPerSecond: number | null; failuresPerSecond: number | null };
  queues: PlatformQueue[];
  slis: PlatformSli[];
  alerts: PlatformAlert[];
  budgets: { configured: boolean; checks: PerfBudgetCheck[]; invalid: string[] };
}

const QUERY = `query PlatformHealth($w: Int) { platformHealth(windowMinutes: $w) {
  observedAt windowMinutes prometheus { reachable version error }
  targets { service job instance health lastScrapeAt scrapeDurationMs lastError requestRate p95Ms errorRatio eventLoopP99Ms residentBytes cpuCores }
  stores { store up probeMs } outbox { pending oldestAgeSeconds deliveredPerSecond failuresPerSecond }
  queues { queue waiting active delayed failed } slis { id unit value objective status }
  alerts { name sli severity state subject activeAt value }
  budgets { configured invalid checks { result measure page value budget comparison withinBudget measuredAt } } } }`;

export const platformHealthQuery = (windowMinutes: PlatformWindowMinutes) =>
  queryOptions({
    queryKey: ['platformHealth', windowMinutes] as const,
    queryFn: ({ signal }) => gql<{ platformHealth: PlatformHealth }>(QUERY, { w: windowMinutes }, signal).then((d) => d.platformHealth),
    refetchInterval: PLATFORM_HEALTH.refreshMs,
    staleTime: PLATFORM_HEALTH.refreshMs,
  });
