// REQ-CMDB-038 REQ-CORE-012 — ClickHouse read client for the API: the analytics store behind headline metrics and
// history reads. Every query runs inside an OpenTelemetry span and is counted by name and outcome, so a slow or
// failing analytics tier shows up in the same place as the GraphQL operation it served.
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { clickhouseOptions } from '@openmap/db';
import { withSpan } from '@openmap/telemetry';
import { ENV, type Env } from '../config/env.module.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService, type RequestStatus } from '../metrics/metrics.service.js';

export type QueryParams = Record<string, string | number | boolean | readonly string[] | readonly number[]>;

/** ClickHouse binds DateTime64 parameters as strings in its own `YYYY-MM-DD hh:mm:ss.sss` form (UTC server). */
export function clickhouseTime(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

@Injectable()
export class ClickHouseService implements OnModuleDestroy {
  private readonly client: ClickHouseClient;
  /** Database the DDL under packages/db/clickhouse was applied to; queries name it explicitly. */
  readonly database: string;

  constructor(
    @Inject(ENV) env: Env,
    private readonly metrics: MetricsService,
  ) {
    this.database = env.CLICKHOUSE_DB;
    this.client = createClient(clickhouseOptions(env));
  }

  /** Runs a named read query with bound parameters and returns its JSONEachRow result. */
  async query<Row>(name: string, sql: string, params: QueryParams): Promise<Row[]> {
    let status: RequestStatus = 'ok';
    try {
      return await withSpan(TRACER_NAME, 'clickhouse.' + name, { 'db.system': 'clickhouse', 'db.name': this.database, 'db.operation': name }, async () => {
        const result = await this.client.query({ query: sql, query_params: params, format: 'JSONEachRow' });
        return result.json<Row>();
      });
    } catch (error) {
      status = 'error';
      throw error;
    } finally {
      this.metrics.clickhouseQueries.inc({ query: name, status });
    }
  }

  /** Inserts rows; used by integration tests and maintenance commands, never by request handlers. */
  async insert(table: string, values: readonly Record<string, unknown>[]): Promise<void> {
    await this.client.insert({ table: this.database + '.' + table, values: [...values], format: 'JSONEachRow' });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.close();
  }
}
