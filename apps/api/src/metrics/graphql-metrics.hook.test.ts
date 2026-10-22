// T-031 REQ-CORE-012 — GraphQL metrics hook helpers and the Prometheus registry.
import { describe, expect, it } from 'vitest';
import { trace } from '@opentelemetry/api';
import { PERF_BUDGETS, TIME } from '@openmap/constants';
import { GraphQLError, parse } from 'graphql';
import { elapsedSeconds, operationNameOf, operationTypeOf, recordOperation, statusOf, ANONYMOUS_OPERATION } from './graphql-metrics.hook.js';
import { durationBuckets, GRAPHQL_DURATION_METRIC, GRAPHQL_REQUESTS_METRIC, MetricsService } from './metrics.service.js';

describe('operation helpers', () => {
  it('reads the operation name and type from the document', () => {
    const doc = parse('mutation LabelIt { labelCi(input: { ciId: "x", title: "t", description: "", layer: dc }) { id } }');
    expect(operationNameOf(doc)).toBe('LabelIt');
    expect(operationTypeOf(doc)).toBe('mutation');
  });
  it('falls back to anonymous', () => {
    expect(operationNameOf(parse('{ layers { layer } }'))).toBe(ANONYMOUS_OPERATION);
    expect(operationTypeOf(parse('{ layers { layer } }'))).toBe('query');
    expect(operationNameOf(parse('fragment F on Ci { id }'))).toBe(ANONYMOUS_OPERATION);
  });
  it('derives status from the error list', () => {
    expect(statusOf(undefined)).toBe('ok');
    expect(statusOf([])).toBe('ok');
    expect(statusOf([new GraphQLError('boom')])).toBe('error');
  });
  it('converts hrtime nanoseconds to seconds', () => {
    expect(elapsedSeconds(0n, 1_500_000_000n)).toBeCloseTo(1.5);
    expect(elapsedSeconds(10n, 10n)).toBe(0);
  });
});

describe('durationBuckets', () => {
  it('is ascending, deduplicated and anchored on both performance budgets', () => {
    const buckets = durationBuckets();
    expect([...buckets].sort((a, b) => a - b)).toEqual(buckets);
    expect(new Set(buckets).size).toBe(buckets.length);
    expect(buckets).toContain(PERF_BUDGETS.screenInteractionP95Ms / TIME.msPerSecond);
    expect(buckets).toContain(PERF_BUDGETS.impactQuery100kP95Ms / TIME.msPerSecond);
    expect(buckets[0]).toBeLessThan(PERF_BUDGETS.screenInteractionP95Ms / TIME.msPerSecond);
    expect(buckets.at(-1)).toBeGreaterThan(PERF_BUDGETS.impactQuery100kP95Ms / TIME.msPerSecond);
  });
});

describe('recordOperation', () => {
  it('increments the counter and observes the histogram with operation and status labels', async () => {
    const metrics = new MetricsService();
    const span = trace.getTracer('test').startSpan('graphql.query layers');
    recordOperation(metrics, { operation: 'layers', startedNs: 0n, span }, undefined, 250_000_000n);
    recordOperation(metrics, { operation: 'layers', startedNs: 0n, span: trace.getTracer('test').startSpan('x') }, [new GraphQLError('denied')], 1_000_000n);
    const json = await metrics.registry.getMetricsAsJSON();
    const counter = json.find((m) => m.name === GRAPHQL_REQUESTS_METRIC);
    expect(counter?.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 1, labels: { operation: 'layers', status: 'ok' } }),
        expect.objectContaining({ value: 1, labels: { operation: 'layers', status: 'error' } }),
      ]),
    );
    const histogram = json.find((m) => m.name === GRAPHQL_DURATION_METRIC);
    const sum = histogram?.values.find((v) => v.metricName === GRAPHQL_DURATION_METRIC + '_sum' && v.labels['status'] === 'ok');
    expect(sum?.value).toBeCloseTo(0.25);
    const text = await metrics.render();
    expect(text).toContain(GRAPHQL_REQUESTS_METRIC + '{operation="layers",status="ok"} 1');
    expect(text).toContain('process_cpu_user_seconds_total');
  });
});
