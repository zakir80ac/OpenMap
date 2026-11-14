// REQ-PERF-005 (ADR-071) — the perf budget result files tools/perf and the console perf spec write (one JSON file per
// measurement under tools/perf/results, or PERF_RESULTS_DIR in a deployment) and the one judgement of them against
// PERF_BUDGETS. `pnpm guard` fails CI on a check out of budget (or on a required result that is missing); the API shows
// the same checks on the Platform health screen. A result that does not parse is reported, never skipped silently.
import { PERF_BUDGETS } from '@openmap/constants';
import { z } from 'zod';

/** Every result a budget is defined for, as the `name` the result file carries (and its file name without `.json`). */
export const PERF_RESULT_NAMES = [
  'screen-interaction',
  'graph-render',
  'impact-query',
  'availability-report',
  'telemetry-fleet',
  'discovery-sweep',
  'lighthouse',
] as const;
export type PerfResultName = (typeof PERF_RESULT_NAMES)[number];

/** The measure a check reads: a latency p95, a frame rate, a sweep time or a Lighthouse category score. */
export const PERF_MEASURES = ['p95Ms', 'fps', 'minutes', 'performance', 'accessibility', 'bestPractices'] as const;
export type PerfMeasure = (typeof PERF_MEASURES)[number];

const lighthousePageSchema = z.object({
  label: z.string().min(1),
  performance: z.number(),
  accessibility: z.number(),
  bestPractices: z.number(),
});

/** The fields a budget reads; result files carry more (samples, metrics, failing audits), which pass through. */
export const perfResultSchema = z.looseObject({
  name: z.string().min(1),
  p95Ms: z.number().optional(),
  fps: z.number().optional(),
  minutes: z.number().optional(),
  pages: z.array(lighthousePageSchema).optional(),
  generatedAt: z.iso.datetime().optional(),
});
export type PerfResult = z.infer<typeof perfResultSchema>;

export interface PerfBudgetCheck {
  result: string;
  measure: PerfMeasure;
  /** The Lighthouse page label; null for a single-value result. */
  page: string | null;
  value: number;
  budget: number;
  /** `max`: the value may not exceed the budget (latency, minutes); `min`: it may not fall under it (fps, scores). */
  comparison: 'max' | 'min';
  withinBudget: boolean;
  measuredAt: string | null;
}

function check(
  r: PerfResult,
  measure: PerfMeasure,
  value: number | undefined,
  budget: number,
  comparison: PerfBudgetCheck['comparison'],
  page: string | null = null,
): PerfBudgetCheck[] {
  if (value === undefined) return [];
  return [
    {
      result: r.name,
      measure,
      page,
      value,
      budget,
      comparison,
      withinBudget: comparison === 'max' ? value <= budget : value >= budget,
      measuredAt: r.generatedAt ?? null,
    },
  ];
}

/**
 * The Lighthouse performance floor for a page, or null for an embedded application's own pass (ADR-076): every
 * console screen, an embedded screen's shell included, is held to the console floor; the pass with the third-party
 * application loaded (`<screen>` + lighthouseEmbeddedSuffix) is reported and not judged on performance.
 */
export function lighthousePerformanceMin(label: string): number | null {
  return label.endsWith(PERF_BUDGETS.lighthouseEmbeddedSuffix) ? null : PERF_BUDGETS.lighthousePerformanceMin;
}

/** Every budget check one result carries; a result with no budget (an unknown name) has none. */
export function perfBudgetChecks(r: PerfResult): PerfBudgetCheck[] {
  switch (r.name) {
    case 'screen-interaction':
    // REQ-UI-027: the telemetry fleet table's GraphQL page is held to the screen interaction budget.
    case 'telemetry-fleet':
      return check(r, 'p95Ms', r.p95Ms, PERF_BUDGETS.screenInteractionP95Ms, 'max');
    case 'impact-query':
      return check(r, 'p95Ms', r.p95Ms, PERF_BUDGETS.impactQuery100kP95Ms, 'max');
    case 'availability-report':
      return check(r, 'p95Ms', r.p95Ms, PERF_BUDGETS.availabilityReportP95Ms, 'max');
    case 'graph-render':
      return check(r, 'fps', r.fps, PERF_BUDGETS.graphRenderFps, 'min');
    case 'discovery-sweep':
      return check(r, 'minutes', r.minutes, PERF_BUDGETS.discoverySweepMinutes, 'max');
    case 'lighthouse':
      return (r.pages ?? []).flatMap((p) => {
        const performanceMin = lighthousePerformanceMin(p.label);
        return [
          ...(performanceMin === null ? [] : check(r, 'performance', p.performance, performanceMin, 'min', p.label)),
          ...check(r, 'accessibility', p.accessibility, PERF_BUDGETS.lighthouseAccessibilityMin, 'min', p.label),
          ...check(r, 'bestPractices', p.bestPractices, PERF_BUDGETS.lighthouseBestPracticesMin, 'min', p.label),
        ];
      });
    default:
      return [];
  }
}

export type ParsedPerfResult =
  | { ok: true; file: string; result: PerfResult; checks: PerfBudgetCheck[] }
  | { ok: false; file: string; error: string };

/** Parses one result file's text; a file that is not JSON or not a result says why. */
export function parsePerfResult(file: string, text: string): ParsedPerfResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, file, error: err instanceof Error ? err.message : String(err) };
  }
  const parsed = perfResultSchema.safeParse(json);
  if (!parsed.success)
    return { ok: false, file, error: parsed.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ') };
  return { ok: true, file, result: parsed.data, checks: perfBudgetChecks(parsed.data) };
}

/** The result names in `required` that no parsed result carries (CI requires the measurements its job ran). */
export function missingPerfResults(results: readonly ParsedPerfResult[], required: readonly string[]): string[] {
  const present = new Set(results.flatMap((r) => (r.ok ? [r.result.name] : [])));
  return required.filter((name) => !present.has(name));
}
