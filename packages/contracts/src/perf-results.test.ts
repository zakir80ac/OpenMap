// T-610 REQ-PERF-005 (ADR-071) — perf budget results: each result name is judged against its PERF_BUDGETS entry (a max
// for latency and minutes, a min for frame rate and Lighthouse scores, the embedded-screen floor for analytics), a file
// that is not a result says why, and a required result that no file carries is named.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PERF_BUDGETS } from '@openmap/constants';
import { describe, expect, it } from 'vitest';
import { missingPerfResults, parsePerfResult, perfBudgetChecks, perfResultSchema } from './perf-results.js';

const at = '2026-11-10T12:00:00.000Z';
const evidence = (name: string): string =>
  readFileSync(fileURLToPath(new URL('../../../docs/evidence/perf/' + name + '.json', import.meta.url)), 'utf8');

describe('perf budget checks', () => {
  it('holds latency results to their p95 budgets', () => {
    const over = perfBudgetChecks(perfResultSchema.parse({ name: 'impact-query', p95Ms: 1200, generatedAt: at }));
    expect(over).toEqual([
      {
        result: 'impact-query',
        measure: 'p95Ms',
        page: null,
        value: 1200,
        budget: PERF_BUDGETS.impactQuery100kP95Ms,
        comparison: 'max',
        withinBudget: false,
        measuredAt: at,
      },
    ]);
    const fleet = perfBudgetChecks(perfResultSchema.parse({ name: 'telemetry-fleet', p95Ms: 40 }));
    expect(fleet[0]).toMatchObject({ budget: PERF_BUDGETS.screenInteractionP95Ms, withinBudget: true, measuredAt: null });
    const report = perfBudgetChecks(perfResultSchema.parse({ name: 'availability-report', p95Ms: 1000 }));
    expect(report[0]?.withinBudget).toBe(true);
  });

  it('holds the frame rate and the sweep to theirs', () => {
    expect(perfBudgetChecks(perfResultSchema.parse({ name: 'graph-render', fps: 59.4 }))[0]).toMatchObject({
      comparison: 'min',
      budget: PERF_BUDGETS.graphRenderFps,
      withinBudget: false,
    });
    expect(perfBudgetChecks(perfResultSchema.parse({ name: 'discovery-sweep', minutes: 9.8 }))[0]).toMatchObject({
      measure: 'minutes',
      withinBudget: true,
    });
  });

  it('checks three Lighthouse categories per page, with the embedded floor for analytics', () => {
    const checks = perfBudgetChecks(
      perfResultSchema.parse({
        name: 'lighthouse',
        pages: [
          { label: 'dashboard', performance: 0.89, accessibility: 1, bestPractices: 1 },
          { label: 'analytics', performance: 0.66, accessibility: 0.96, bestPractices: 0.94 },
        ],
      }),
    );
    expect(checks).toHaveLength(6);
    expect(checks.filter((c) => !c.withinBudget).map((c) => [c.page, c.measure])).toEqual([
      ['dashboard', 'performance'],
      ['analytics', 'bestPractices'],
    ]);
    expect(checks.find((c) => c.page === 'analytics' && c.measure === 'performance')?.budget).toBe(
      PERF_BUDGETS.lighthouseEmbeddedPerformanceMin,
    );
  });

  it('reads the committed evidence results, and says why a file is not a result', () => {
    const screen = parsePerfResult('screen-interaction.json', evidence('screen-interaction'));
    expect(screen.ok && screen.checks[0]?.withinBudget).toBe(true);
    const lighthouse = parsePerfResult('lighthouse.json', evidence('lighthouse'));
    expect(lighthouse.ok && lighthouse.checks.length).toBeGreaterThan(0);
    const broken = parsePerfResult('broken.json', '{"name": ');
    expect(broken.ok).toBe(false);
    const wrong = parsePerfResult('wrong.json', JSON.stringify({ name: 'impact-query', p95Ms: 'fast' }));
    expect(wrong.ok === false && wrong.error).toMatch(/p95Ms/u);
    expect(perfBudgetChecks(perfResultSchema.parse({ name: 'unbudgeted', p95Ms: 1 }))).toEqual([]);
  });

  it('names the required results no file carries', () => {
    const results = [parsePerfResult('a.json', JSON.stringify({ name: 'impact-query', p95Ms: 10 }))];
    expect(missingPerfResults(results, ['impact-query', 'telemetry-fleet'])).toEqual(['telemetry-fleet']);
  });
});
