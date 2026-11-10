// REQ-PERF-005 (ADR-071) — a small reader of the Prometheus HTTP API (instant queries, active targets, alerts, build
// info) at PROMETHEUS_URL. The deployment's own Prometheus is inside the stack, so this is local in the airgap profile
// too. Every call has PLATFORM_HEALTH.prometheusTimeoutMs; a non-success answer is an error with Prometheus's reason.
import { PLATFORM_HEALTH } from '@openmap/constants';
import { z } from 'zod';

const sampleSchema = z.tuple([z.number(), z.string()]);
const envelopeSchema = z.object({
  status: z.enum(['success', 'error']),
  data: z.unknown().optional(),
  error: z.string().optional(),
  errorType: z.string().optional(),
});
const vectorSchema = z.object({
  resultType: z.literal('vector'),
  result: z.array(z.object({ metric: z.record(z.string(), z.string()), value: sampleSchema })),
});
const scalarSchema = z.object({ resultType: z.literal('scalar'), result: sampleSchema });
const targetsSchema = z.object({
  activeTargets: z.array(
    z.object({
      labels: z.record(z.string(), z.string()),
      scrapePool: z.string(),
      health: z.enum(['up', 'down', 'unknown']),
      lastError: z.string(),
      lastScrape: z.string(),
      lastScrapeDuration: z.number(),
    }),
  ),
});
const alertsSchema = z.object({
  alerts: z.array(
    z.object({
      labels: z.record(z.string(), z.string()),
      state: z.enum(['firing', 'pending', 'inactive']),
      activeAt: z.string().optional(),
      value: z.string().optional(),
    }),
  ),
});
const buildInfoSchema = z.object({ version: z.string() });

export interface PromSample {
  labels: Record<string, string>;
  /** NaN and infinities (an empty histogram, a 0/0 ratio) come back as null: nothing was measured. */
  value: number | null;
}
export type PromTarget = z.infer<typeof targetsSchema>['activeTargets'][number];
export type PromAlert = z.infer<typeof alertsSchema>['alerts'][number];

export class PrometheusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrometheusError';
  }
}

function sampleValue(raw: string): number | null {
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

export class PrometheusClient {
  private readonly base: string;

  constructor(
    url: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = PLATFORM_HEALTH.prometheusTimeoutMs,
  ) {
    this.base = url.endsWith('/') ? url : url + '/';
  }

  private async get(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const target = new URL(path, this.base);
    for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
    const res = await this.fetchImpl(target, { signal: AbortSignal.timeout(this.timeoutMs) });
    const body = envelopeSchema.safeParse(await res.json().catch(() => null));
    if (!body.success) throw new PrometheusError('Prometheus answered ' + String(res.status) + ' without an API envelope');
    if (body.data.status !== 'success')
      throw new PrometheusError((body.data.errorType ?? 'error') + ': ' + (body.data.error ?? String(res.status)));
    return body.data.data;
  }

  /** An instant query; a scalar result is returned as one unlabelled sample. */
  async query(expr: string): Promise<PromSample[]> {
    const data = await this.get('api/v1/query', { query: expr });
    const scalar = scalarSchema.safeParse(data);
    if (scalar.success) return [{ labels: {}, value: sampleValue(scalar.data.result[1]) }];
    const vector = vectorSchema.parse(data);
    return vector.result.map((r) => ({ labels: r.metric, value: sampleValue(r.value[1]) }));
  }

  async targets(): Promise<PromTarget[]> {
    return targetsSchema.parse(await this.get('api/v1/targets', { state: 'active' })).activeTargets;
  }

  async alerts(): Promise<PromAlert[]> {
    return alertsSchema.parse(await this.get('api/v1/alerts')).alerts;
  }

  async version(): Promise<string> {
    return buildInfoSchema.parse(await this.get('api/v1/status/buildinfo')).version;
  }
}
