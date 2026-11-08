// REQ-PERF-004 — times a discovery sweep of the synthetic estate end to end and writes results/discovery-sweep.json,
// which `pnpm guard` checks against PERF_BUDGETS.discoverySweepMinutes per PERF_BUDGETS.discoverySweepDevices:
// - generates the estate (`synth generate`, a seed of its own so the measured tenant is new);
// - replays it through the real pipeline (`reconciler replay --reset`): every collector result reconciled into
//   Postgres, the pending and dependency-mapping passes, and the outbox dispatched to Memgraph, ClickHouse and
//   Meilisearch, as ADR-046 measured it;
// - counts the devices (hosts and network devices) and scales the wall-clock time to minutes per 10,000 devices.
// Stop any other outbox dispatcher (the compose reconciler) first: two dispatchers deliver the same rows twice.
// Usage: pnpm --filter @openmap/perf discovery-sweep [--seed 44] [--scale 0.25] [--out <dir>]
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERF_BUDGETS, TIME } from '@openmap/constants';

const SWEEP = {
  defaultSeed: '44',
  defaultScale: '0.25',
  deviceTypes: ['host', 'network_device'],
  minutePrecision: 2,
} as const;

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};

const seed = flag('seed', SWEEP.defaultSeed);
const scale = flag('scale', SWEEP.defaultScale);
const out = resolve(flag('out', join(tmpdir(), 'openmap-sweep-' + seed + '-' + scale)));
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const resultsDir = fileURLToPath(new URL('../results/', import.meta.url));

function run(step: string, command: string, commandArgs: string[]): void {
  const r = spawnSync(command, commandArgs, { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(step + ' failed with status ' + String(r.status));
}

run('generate', 'pnpm', ['--filter', '@openmap/synth-estate', 'synth', 'generate', '--seed', seed, '--scale', scale, '--out', out]);
const summary = JSON.parse(readFileSync(join(out, 'estate-summary.json'), 'utf8')) as { tenantId: string; totals: { cis: number }; ciTypes: Record<string, number> };
const devices = SWEEP.deviceTypes.reduce((n, t) => n + (summary.ciTypes[t] ?? 0), 0);

const started = Date.now();
run('replay', 'pnpm', ['--filter', '@openmap/reconciler', 'replay', '--dir', out, '--reset']);
const totalMinutes = (Date.now() - started) / TIME.msPerSecond / TIME.secondsPerMinute;
const minutes = Number(((totalMinutes * PERF_BUDGETS.discoverySweepDevices) / Math.max(1, devices)).toFixed(SWEEP.minutePrecision));

const result = {
  name: 'discovery-sweep',
  /** Minutes per PERF_BUDGETS.discoverySweepDevices devices: the figure guard checks. */
  minutes,
  budgetMinutes: PERF_BUDGETS.discoverySweepMinutes,
  devices,
  cis: summary.totals.cis,
  totalMinutes: Number(totalMinutes.toFixed(SWEEP.minutePrecision)),
  seed: Number(seed),
  scale: Number(scale),
  tenantId: summary.tenantId,
  generatedAt: new Date().toISOString(),
};
mkdirSync(resultsDir, { recursive: true });
writeFileSync(join(resultsDir, 'discovery-sweep.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
process.exit(minutes > PERF_BUDGETS.discoverySweepMinutes ? 1 : 0);
