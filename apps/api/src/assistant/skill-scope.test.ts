// T-460 T-461 T-462 REQ-AI-007 REQ-AI-008 (ADR-028) — skill rules the evaluation set cannot see, because it checks
// the skill and the evidence, not the figure:
// - T-460: `metrics.latest` without a name or filter reads only CIs of the step's type. Every hardware CI carries the
//   host load headline, BMCs included, so "CPU of hosts" must not average the BMCs in.
// - T-461: `services.availability` reads the period `back` steps before the current one; the report lists periods
//   oldest first, so "last month" is the first of two, not the second.
// - T-462: a scope larger than one ClickHouse parameter carries is read in id batches whose partials combine
//   exactly (count, sum, extremes, top N); the evidence carries the scope size, not the ids.
// The stores are stand-ins here; the real stack runs the same paths in the evaluation (T-143).
import { describe, expect, it } from 'vitest';
import type { QueryParams } from '../db/clickhouse.service.js';
import type { SkillContext } from './skills/skill.js';
import { MetricsSkill } from './skills/metrics.skill.js';
import { ServicesSkill } from './skills/services.skill.js';

const HOST_IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

interface RawCall {
  sql: string;
  values: unknown[];
}

function metricsSkill(captured: QueryParams[], raw: RawCall[]): MetricsSkill {
  const clickhouse = {
    database: 'openmap',
    query: (_name: string, _sql: string, params: QueryParams) => {
      captured.push(params);
      return Promise.resolve([{ count: 2, avg: 40, sum: 80, min: 30, max: 50, ts_ms: 1_000 }]);
    },
  };
  const prisma = {
    client: {
      $queryRaw: (query: { sql: string; values: unknown[] }) => {
        raw.push({ sql: query.sql, values: query.values });
        return Promise.resolve(HOST_IDS.map((id) => ({ id })));
      },
    },
  };
  const cis = { findByIds: () => Promise.resolve([]) };
  const catalogue = { resolveFilters: () => Promise.resolve({ resolved: [], unresolved: [] }) };
  const resolver = { resolve: () => Promise.resolve({ name: '', exact: [], close: [] }) };
  return new MetricsSkill(
    clickhouse as unknown as ConstructorParameters<typeof MetricsSkill>[0],
    prisma as unknown as ConstructorParameters<typeof MetricsSkill>[1],
    cis as unknown as ConstructorParameters<typeof MetricsSkill>[2],
    catalogue as unknown as ConstructorParameters<typeof MetricsSkill>[3],
    resolver as unknown as ConstructorParameters<typeof MetricsSkill>[4],
  );
}

function period(start: string, downtimeMinutes: number): Record<string, unknown> {
  const elapsedMinutes = 44_640;
  return {
    periodStart: start,
    availabilityPercent: 100 - (downtimeMinutes / elapsedMinutes) * 100,
    downtimeMinutes,
    elapsedMinutes,
    unknownMinutes: 0,
    targetPercent: null,
    met: null,
  };
}

function servicesSkill(): ServicesSkill {
  const report = [
    {
      service: { id: HOST_IDS[0], displayName: 'Mobile Banking' },
      // Oldest first: October (with downtime), then the current month.
      periods: [period('2026-10-01T00:00:00.000Z', 265), period('2026-11-01T00:00:00.000Z', 0)],
    },
  ];
  const services = { report: () => Promise.resolve(report) };
  const resolver = { resolveAll: () => Promise.resolve([]) };
  const cis = {};
  return new ServicesSkill(
    services as unknown as ConstructorParameters<typeof ServicesSkill>[0],
    resolver as unknown as ConstructorParameters<typeof ServicesSkill>[1],
    cis as unknown as ConstructorParameters<typeof ServicesSkill>[2],
  );
}

const context: SkillContext = { tenantId: 't', locale: 'en', question: 'average CPU of hosts', types: ['host'] };

describe('assistant skill scope', () => {
  it('T-460 scopes an unfiltered measurement to CIs of the step type', async () => {
    const captured: QueryParams[] = [];
    const raw: RawCall[] = [];
    const outcome = await metricsSkill(captured, raw).run(
      { skill: 'metrics.latest', metric: 'host.cpu.utilisation_percent', type: 'host', aggregate: 'avg', names: [], filters: [], topN: 5 },
      context,
    );
    expect(outcome.results[0]?.error).toBeNull();
    expect(raw).toHaveLength(1);
    expect(raw[0]?.values).toContain('host');
    expect(captured[0]).toMatchObject({ metric: 'host.cpu.utilisation_percent', ids: HOST_IDS });
  });

  it('T-462 reads a large scope in id batches and combines them exactly', async () => {
    // 4,500 hosts: more than one bound parameter may carry, so the read is split and the partials are added up.
    const ids = Array.from({ length: 4_500 }, (_, i) => '00000000-0000-4000-8000-' + String(i).padStart(12, '0'));
    const batches: string[][] = [];
    const clickhouse = {
      database: 'openmap',
      query: (name: string, _sql: string, params: QueryParams) => {
        const batch = params['ids'] as string[];
        batches.push(batch);
        // Value of a host is its index: the batch's count, sum, extremes, and its top two for the ranking.
        const values = batch.map((id) => Number(id.slice(-12)));
        if (name === 'assistant_aggregate') {
          return Promise.resolve([{ count: values.length, sum: values.reduce((a, b) => a + b, 0), min: Math.min(...values), max: Math.max(...values), ts_ms: 1_000 + values.length }]);
        }
        if (name === 'assistant_ranked') {
          return Promise.resolve(batch.slice(-2).reverse().map((id) => ({ ci_id: id, v: Number(id.slice(-12)) })));
        }
        return Promise.resolve([{ count: values.length, ts_ms: 1_000 }]);
      },
    };
    const prisma = { client: { $queryRaw: () => Promise.resolve(ids.map((id) => ({ id }))) } };
    const s = new MetricsSkill(
      clickhouse as unknown as ConstructorParameters<typeof MetricsSkill>[0],
      prisma as unknown as ConstructorParameters<typeof MetricsSkill>[1],
      { findByIds: () => Promise.resolve([]) } as unknown as ConstructorParameters<typeof MetricsSkill>[2],
      { resolveFilters: () => Promise.resolve({ resolved: [], unresolved: [] }) } as unknown as ConstructorParameters<typeof MetricsSkill>[3],
      { resolve: () => Promise.resolve({ name: '', exact: [], close: [] }) } as unknown as ConstructorParameters<typeof MetricsSkill>[4],
    );
    const avg = await s.run({ skill: 'metrics.latest', metric: 'host.cpu.utilisation_percent', type: 'host', aggregate: 'avg', names: [], filters: [], topN: 5 }, context);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(ids);
    expect(avg.results[0]?.summary).toMatchObject({ kind: 'measurement', count: 4_500, value: 2_249.5 });
    // The evidence names the size of the scope, not the ids.
    expect(avg.results[0]?.params).toMatchObject({ cis: 4_500 });
    expect(avg.results[0]?.params).not.toHaveProperty('ids');

    batches.length = 0;
    const top = await s.run({ skill: 'metrics.latest', metric: 'host.cpu.utilisation_percent', type: 'host', aggregate: 'max', names: [], filters: [], topN: 2 }, context);
    expect(top.results[0]?.summary).toMatchObject({ count: 4_500, value: 4_499 });
    expect(top.results[0]?.ciIds).toEqual([ids[4_499], ids[4_498]]);
  });

  it('T-461 reads last month as the period before the current one', async () => {
    const s = servicesSkill();
    const last = await s.availability({ skill: 'services.availability', granularity: 'month', back: 1, names: [] }, context);
    expect(last.results[0]?.summary).toMatchObject({ kind: 'availability', periodStart: '2026-10-01T00:00:00.000Z', downtimeMinutes: 265 });
    const current = await s.availability({ skill: 'services.availability', granularity: 'month', back: 0, names: [] }, context);
    expect(current.results[0]?.summary).toMatchObject({ periodStart: '2026-11-01T00:00:00.000Z', downtimeMinutes: 0 });
  });
});
