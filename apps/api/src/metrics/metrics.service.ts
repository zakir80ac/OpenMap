// REQ-CORE-012 — Prometheus registry: Node default metrics plus the GraphQL request counter and
// duration histogram. Bucket edges derive from the performance budgets so alerts align with them.
import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { IPV4, PERF_BUDGETS, TIME } from '@openmap/constants';

export const GRAPHQL_REQUESTS_METRIC = 'openmap_graphql_requests_total';
export const GRAPHQL_DURATION_METRIC = 'openmap_graphql_duration_seconds';
/** REQ-SEC-005 — audit entries written, by mutation name. */
export const AUDIT_ENTRIES_METRIC = 'openmap_audit_entries_total';
/** REQ-UI-017 — Superset guest tokens minted for embedded analytics. */
export const ANALYTICS_TOKENS_METRIC = 'openmap_analytics_guest_tokens_total';
/** REQ-CMDB-038 — ClickHouse read queries issued by the API, by query name and outcome. */
export const CLICKHOUSE_QUERIES_METRIC = 'openmap_clickhouse_queries_total';

export type RequestStatus = 'ok' | 'error';

/**
 * Histogram edges in seconds: the screen-interaction budget halved twice below it, then doubling up
 * to four times the impact-query budget, so both p95 budgets fall exactly on a bucket boundary.
 */
export function durationBuckets(): number[] {
  const screen = PERF_BUDGETS.screenInteractionP95Ms / TIME.msPerSecond;
  const impact = PERF_BUDGETS.impactQuery100kP95Ms / TIME.msPerSecond;
  const ratio = IPV4.binaryBase;
  const edges = [screen / ratio / ratio, screen / ratio, screen];
  let edge = screen * ratio;
  while (edge < impact) {
    edges.push(edge);
    edge *= ratio;
  }
  edges.push(impact, impact * ratio, impact * ratio * ratio);
  return [...new Set(edges)].sort((a, b) => a - b);
}

@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly requests: Counter<'operation' | 'status'>;
  readonly duration: Histogram<'operation' | 'status'>;
  readonly auditEntries: Counter<'action'>;
  readonly analyticsTokens: Counter<string>;
  readonly clickhouseQueries: Counter<'query' | 'status'>;

  constructor() {
    collectDefaultMetrics({ register: this.registry });
    this.requests = new Counter({ name: GRAPHQL_REQUESTS_METRIC, help: 'GraphQL operations served, by operation name and outcome', labelNames: ['operation', 'status'], registers: [this.registry] });
    this.duration = new Histogram({ name: GRAPHQL_DURATION_METRIC, help: 'GraphQL operation duration in seconds', labelNames: ['operation', 'status'], buckets: durationBuckets(), registers: [this.registry] });
    this.auditEntries = new Counter({ name: AUDIT_ENTRIES_METRIC, help: 'Audit log entries written, by mutation', labelNames: ['action'], registers: [this.registry] });
    this.analyticsTokens = new Counter({ name: ANALYTICS_TOKENS_METRIC, help: 'Superset guest tokens minted for embedded analytics', registers: [this.registry] });
    this.clickhouseQueries = new Counter({ name: CLICKHOUSE_QUERIES_METRIC, help: 'ClickHouse read queries issued by the API, by query name and outcome', labelNames: ['query', 'status'], registers: [this.registry] });
  }

  observe(operation: string, status: RequestStatus, seconds: number): void {
    this.requests.inc({ operation, status });
    this.duration.observe({ operation, status }, seconds);
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
