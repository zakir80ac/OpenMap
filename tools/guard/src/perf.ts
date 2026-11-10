// REQ-PERF-005 REQ-CORE-008 — the guard's perf budget rule: every result file under tools/perf/results is judged by the
// one evaluation in @openmap/contracts (perf-results.ts, which the Platform health screen uses too). A check out of
// budget, a file that is not a result, and (with --require-perf) a measurement the CI job ran but did not write are
// findings, so a budget can no longer pass by its measurement silently not running.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { missingPerfResults, parsePerfResult, type ParsedPerfResult, type PerfBudgetCheck } from '@openmap/contracts';
import type { Finding } from './rules.js';

const RESULTS_PATH = 'tools/perf/results/';

function describeCheck(c: PerfBudgetCheck): string {
  const what = (c.page === null ? c.result : c.page + ' ' + c.result) + ' ' + c.measure;
  return what + ' ' + String(c.value) + (c.comparison === 'max' ? ' over ' : ' under ') + String(c.budget);
}

export function readPerfResults(dir: string): ParsedPerfResult[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => parsePerfResult(f, readFileSync(join(dir, f), 'utf8')));
}

export function perfFindings(dir: string, required: readonly string[] = []): Finding[] {
  const results = readPerfResults(dir);
  const out: Finding[] = [];
  for (const r of results) {
    const file = RESULTS_PATH + r.file;
    if (!r.ok) {
      out.push({ rule: 'perf-result', file, line: 1, message: 'not a perf result: ' + r.error });
      continue;
    }
    for (const c of r.checks)
      if (!c.withinBudget) out.push({ rule: 'perf-budget', file, line: 1, message: describeCheck(c) });
  }
  for (const name of missingPerfResults(results, required))
    out.push({ rule: 'perf-missing', file: RESULTS_PATH + name + '.json', line: 1, message: 'required perf result ' + name + ' was not written' });
  return out;
}

/** `--require-perf a,b` from the command line; empty when the flag is absent. */
export function requiredFromArgs(argv: readonly string[]): string[] {
  const i = argv.indexOf('--require-perf');
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value === undefined ? [] : value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}
