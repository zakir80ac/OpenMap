// T-146 REQ-AI-008 (ADR-028) — `metrics.series` offline: the window is bound as ClickHouse parameters (from, to,
// bucket seconds, hours), the buckets are reduced to a sample-weighted average, the minimum, the maximum, the first
// and last readings and the trend, a named CI is resolved to one id and cited, and an empty window is a summary
// with no samples, never an error. The stores are stand-ins here; the real stack runs the same SQL in T-143.
import { describe, expect, it } from 'vitest';
import type { CiRecord } from '../ci/ci.types.js';
import type { QueryParams } from '../db/clickhouse.service.js';
import type { SkillContext } from './skills/skill.js';
import { MetricsSkill } from './skills/metrics.skill.js';

interface Captured {
  sql: string;
  params: QueryParams;
}

const host = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 't',
  type: 'host',
  layer: 'hardware',
  name: 'srv-01',
  displayName: 'srv-01.bank.local',
  code: 'SRV-01',
} as unknown as CiRecord;

function skill(rows: Array<Record<string, unknown>>, captured: Captured[]): MetricsSkill {
  const clickhouse = {
    database: 'openmap',
    query: (_name: string, sql: string, params: QueryParams) => {
      captured.push({ sql, params });
      return Promise.resolve(rows);
    },
  };
  const prisma = { client: { $queryRaw: () => Promise.resolve([]) } };
  const cis = { findByIds: () => Promise.resolve([host]) };
  const catalogue = { resolveFilters: () => Promise.resolve({ resolved: [], unresolved: [] }) };
  const resolver = {
    resolve: (_tenant: string, name: string) =>
      Promise.resolve({ name, exact: name === 'srv-01' ? [host] : [], close: [] }),
  };
  return new MetricsSkill(
    clickhouse as unknown as ConstructorParameters<typeof MetricsSkill>[0],
    prisma as unknown as ConstructorParameters<typeof MetricsSkill>[1],
    cis as unknown as ConstructorParameters<typeof MetricsSkill>[2],
    catalogue as unknown as ConstructorParameters<typeof MetricsSkill>[3],
    resolver as unknown as ConstructorParameters<typeof MetricsSkill>[4],
  );
}

const context: SkillContext = { tenantId: 't', locale: 'en', question: 'CPU of host srv-01 over the last 7 days', types: ['host'] };

describe('metrics.series', () => {
  it('binds the window, reduces the buckets and cites the named CI', async () => {
    const captured: Captured[] = [];
    const s = skill(
      [
        { bucket_ms: 1_000, sum: 80, min: 10, max: 60, samples: 2, cis: 1 },
        { bucket_ms: 2_000, sum: 120, min: 50, max: 90, samples: 2, cis: 1 },
      ],
      captured,
    );
    const outcome = await s.series(
      { skill: 'metrics.series', metric: 'host.cpu.utilisation_percent', type: 'host', aggregate: 'avg', names: ['srv-01'], filters: [], hours: 168, offsetHours: 0 },
      context,
    );
    expect(outcome.clarification).toBeNull();
    const first = outcome.results[0];
    expect(first?.error).toBeNull();
    expect(first?.ciIds).toEqual([host.id]);
    expect(captured[0]?.params).toMatchObject({ metric: 'host.cpu.utilisation_percent', hours: 168, offsetHours: 0, ids: [host.id] });
    expect(captured[0]?.sql).toContain('.metrics WHERE');
    expect(captured[0]?.sql).toContain('toStartOfInterval');
    const from = new Date(String(captured[0]?.params['from']) + 'Z').getTime();
    const to = new Date(String(captured[0]?.params['to']) + 'Z').getTime();
    expect((to - from) / 3_600_000).toBe(168);
    expect(first?.summary).toMatchObject({
      kind: 'series',
      ci: { ciId: host.id, name: host.displayName },
      samples: 4,
      avg: 50,
      min: 10,
      max: 90,
      first: 40,
      last: 60,
      trendPercent: 50,
      hours: 168,
      unit: '%',
    });
    expect(first?.rows).toHaveLength(2);
  });

  it('answers an empty window with a sample-less summary and asks back for an unknown name', async () => {
    const captured: Captured[] = [];
    const s = skill([], captured);
    const empty = await s.series(
      { skill: 'metrics.series', metric: 'vm.cpu.utilisation_percent', type: 'vm', aggregate: 'avg', names: [], filters: [], hours: 24, offsetHours: 720 },
      context,
    );
    expect(empty.results[0]?.summary).toMatchObject({ kind: 'series', ci: null, samples: 0, avg: null, trendPercent: null });
    // Unnamed and unfiltered, the window still covers only CIs of the step's type (T-460); the stand-in holds none,
    // so nothing is read from ClickHouse.
    expect(captured).toHaveLength(0);
    const unknown = await s.series(
      { skill: 'metrics.series', metric: 'host.cpu.utilisation_percent', type: 'host', aggregate: 'avg', names: ['nope'], filters: [], hours: 24, offsetHours: 0 },
      context,
    );
    expect(unknown.results).toEqual([]);
    expect(unknown.clarification?.key).toBe('assistant.clarify.noMatch');
  });
});
