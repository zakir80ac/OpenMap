// REQ-CORE-008 REQ-PERF-005 — guard CLI: scans apps/ and packages/, runs tracker verify, checks perf budget results.
// Flags: --no-tracker skips tracker verify; --perf-only skips the source scan (a CI perf job after `verify` ran it);
// --require-perf a,b fails when the named results were not written (the job's measurement did not run).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { perfFindings, requiredFromArgs } from './perf.js';
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

function trackerVerify(): boolean {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(pnpm, ['tracker', 'verify'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

function main(): void {
  const perfOnly = process.argv.includes('--perf-only');
  const findings = [...(perfOnly ? [] : scan()), ...perfFindings(PERF_RESULTS, requiredFromArgs(process.argv))];
  for (const f of findings)
    console.error('guard: ' + f.file + ':' + String(f.line) + ' [' + f.rule + '] ' + f.message);
  const trackerOk = process.argv.includes('--no-tracker') || perfOnly ? true : trackerVerify();
  if (findings.length > 0 || !trackerOk) {
    console.error(
      'guard: ' + String(findings.length) + ' finding(s)' + (trackerOk ? '' : ', tracker verify failed'),
    );
    process.exit(1);
  }
  console.log('guard: ok');
}

main();
