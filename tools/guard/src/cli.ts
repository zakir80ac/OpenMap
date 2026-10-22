// REQ-CORE-008 — guard CLI: scans apps/ and packages/, runs tracker verify, checks perf budget results.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PERF_BUDGETS } from '@openmap/constants';
import { runRules, type Finding } from './rules.js';

const repoRoot = resolve(process.cwd(), '..', '..');
const SCAN_DIRS = ['apps', 'packages'];
const SKIP = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', 'schemas']);
/** Files a toolchain generates and git ignores (Next.js writes next-env.d.ts on every build); never hand-written. */
const SKIP_FILES = new Set(['next-env.d.ts']);
const PERF_RESULTS = join(repoRoot, 'tools', 'perf', 'results');

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (!SKIP_FILES.has(entry)) yield full;
  }
}

function scan(): Finding[] {
  const findings: Finding[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(repoRoot, dir))) {
      const path = relative(repoRoot, file).split('\\').join('/');
      findings.push(...runRules({ path, text: readFileSync(file, 'utf8') }));
    }
  }
  return findings;
}

interface LighthousePage {
  label: string;
  performance: number;
  accessibility: number;
  bestPractices: number;
}

interface PerfResult {
  name: string;
  p95Ms?: number;
  fps?: number;
  minutes?: number;
  pages?: LighthousePage[];
}

function perfBudgets(): Finding[] {
  if (!existsSync(PERF_RESULTS)) return [];
  const out: Finding[] = [];
  for (const file of readdirSync(PERF_RESULTS)) {
    if (!file.endsWith('.json')) continue;
    const r = JSON.parse(readFileSync(join(PERF_RESULTS, file), 'utf8')) as PerfResult;
    const path = 'tools/perf/results/' + file;
    if (r.name === 'screen-interaction' && r.p95Ms !== undefined && r.p95Ms > PERF_BUDGETS.screenInteractionP95Ms) out.push({ rule: 'perf-budget', file: path, line: 1, message: 'screen p95 ' + String(r.p95Ms) + ' ms over ' + String(PERF_BUDGETS.screenInteractionP95Ms) });
    if (r.name === 'impact-query' && r.p95Ms !== undefined && r.p95Ms > PERF_BUDGETS.impactQuery100kP95Ms) out.push({ rule: 'perf-budget', file: path, line: 1, message: 'impact p95 ' + String(r.p95Ms) + ' ms over ' + String(PERF_BUDGETS.impactQuery100kP95Ms) });
    if (r.name === 'graph-render' && r.fps !== undefined && r.fps < PERF_BUDGETS.graphRenderFps) out.push({ rule: 'perf-budget', file: path, line: 1, message: 'graph ' + String(r.fps) + ' fps under ' + String(PERF_BUDGETS.graphRenderFps) });
    if (r.name === 'discovery-sweep' && r.minutes !== undefined && r.minutes > PERF_BUDGETS.discoverySweepMinutes) out.push({ rule: 'perf-budget', file: path, line: 1, message: 'sweep ' + String(r.minutes) + ' min over ' + String(PERF_BUDGETS.discoverySweepMinutes) });
    if (r.name === 'lighthouse' && r.pages !== undefined) {
      for (const page of r.pages) {
        if (page.performance < PERF_BUDGETS.lighthousePerformanceMin) out.push({ rule: 'perf-budget', file: path, line: 1, message: page.label + ' Lighthouse performance ' + String(page.performance) + ' under ' + String(PERF_BUDGETS.lighthousePerformanceMin) });
        if (page.accessibility < PERF_BUDGETS.lighthouseAccessibilityMin) out.push({ rule: 'perf-budget', file: path, line: 1, message: page.label + ' Lighthouse accessibility ' + String(page.accessibility) + ' under ' + String(PERF_BUDGETS.lighthouseAccessibilityMin) });
        if (page.bestPractices < PERF_BUDGETS.lighthouseBestPracticesMin) out.push({ rule: 'perf-budget', file: path, line: 1, message: page.label + ' Lighthouse best practices ' + String(page.bestPractices) + ' under ' + String(PERF_BUDGETS.lighthouseBestPracticesMin) });
      }
    }
  }
  return out;
}

function trackerVerify(): boolean {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(pnpm, ['tracker', 'verify'], { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
  return result.status === 0;
}

function main(): void {
  const findings = [...scan(), ...perfBudgets()];
  for (const f of findings) console.error('guard: ' + f.file + ':' + String(f.line) + ' [' + f.rule + '] ' + f.message);
  const trackerOk = process.argv.includes('--no-tracker') ? true : trackerVerify();
  if (findings.length > 0 || !trackerOk) {
    console.error('guard: ' + String(findings.length) + ' finding(s)' + (trackerOk ? '' : ', tracker verify failed'));
    process.exit(1);
  }
  console.log('guard: ok');
}

main();
