// REQ-QA-001 REQ-BSM-008 — synth-estate CLI: `generate` writes one NDJSON file per collector family plus
// estate-summary.json, services.json and organization.json; `stats` summarises an output directory; `health-history`
// draws the deterministic outage history of the business services into health-history.json (ADR-024);
// `utilisation-history` writes sample-only results with the servers' and VMs' utilisation over recent days (REQ-CMDB-034).
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { SLA } from '@openmap/constants';
import { join, resolve } from 'node:path';
import { buildEstate } from './estate.js';
import { emitEstate, NDJSON_SUFFIX, SERVICES_FILE, SUMMARY_FILE } from './emit.js';
import { generateHealthHistory, HEALTH_HISTORY_FILE } from './health.js';
import { UTILISATION_HISTORY_FILE, utilisationHistory } from './utilisation.js';
import { POWER_HISTORY_FILE, powerHistory } from './power.js';
import { ENVIRONMENT_HISTORY_FILE, environmentHistory } from './environment.js';
import type { CollectorResult } from '@openmap/contracts';
import { copyFileSync, mkdirSync } from 'node:fs';
import type { BusinessServiceRecord } from './gen/applications.js';

const DEFAULT_SEED = 42;
const DEFAULT_SCALE = 1;
const DEFAULT_OUT = join('..', '..', 'packages', 'testing', 'fixtures', 'synth');
const MS_PER_SECOND = 1000;
const BYTES_PER_MIB = 1024 * 1024;
const NEWLINE = '\n';

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function numberFlag(flags: Flags, key: string, fallback: number): number {
  const raw = flags[key];
  if (raw === undefined || raw === true) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error('--' + key + ' must be a number, got ' + String(raw));
  return n;
}

function stringFlag(flags: Flags, key: string, fallback: string): string {
  const raw = flags[key];
  return typeof raw === 'string' ? raw : fallback;
}

function table(rows: Array<[string, string | number]>): string {
  const width = rows.reduce((w, [k]) => Math.max(w, k.length), 0);
  return rows.map(([k, v]) => '  ' + k.padEnd(width) + '  ' + String(v)).join('\n');
}

function recordRows(rec: Record<string, number>): Array<[string, number]> {
  return Object.entries(rec).sort((a, b) => b[1] - a[1]);
}

async function generate(flags: Flags): Promise<void> {
  const seed = numberFlag(flags, 'seed', DEFAULT_SEED);
  const scale = numberFlag(flags, 'scale', DEFAULT_SCALE);
  const out = resolve(process.cwd(), stringFlag(flags, 'out', DEFAULT_OUT));
  const t0 = performance.now();
  const estate = buildEstate(seed, scale);
  const built = performance.now();
  const report = await emitEstate(estate, out);
  const done = performance.now();
  const s = report.summary;
  console.log('synth-estate: seed ' + String(seed) + ', scale ' + String(scale) + ' -> ' + out);
  console.log(
    table([
      ['CIs', s.totals.cis],
      ['relationships', s.totals.relationships],
      ['collector results', s.totals.results],
      ['business services', s.businessServices],
      ['build time', ((built - t0) / MS_PER_SECOND).toFixed(1) + ' s'],
      ['emit time', ((done - built) / MS_PER_SECOND).toFixed(1) + ' s'],
      ['output size', (report.files.reduce((a, f) => a + f.bytes, 0) / BYTES_PER_MIB).toFixed(1) + ' MiB'],
    ]),
  );
  console.log('files:');
  console.log(
    table(
      report.files.map(
        (f) =>
          [
            f.family + NDJSON_SUFFIX,
            String(f.results) + ' results, ' + String(f.cis) + ' CIs, ' + String(f.relationships) + ' rels',
          ] as [string, string],
      ),
    ),
  );
  console.log('CI types:');
  console.log(table(recordRows(s.ciTypes)));
  console.log('layers:');
  console.log(table(recordRows(s.layers)));
}

async function countLines(path: string): Promise<number> {
  return new Promise((resolveCount, reject) => {
    let lines = 0;
    const stream = createReadStream(path);
    stream.on('data', (chunk: string | Buffer) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      for (const byte of buf) if (byte === 0x0a) lines++;
    });
    stream.on('end', () => {
      resolveCount(lines);
    });
    stream.on('error', reject);
  });
}

interface StoredSummary {
  seed: number;
  scale: number;
  totals: { cis: number; relationships: number; results: number };
  businessServices: number;
  ciTypes: Record<string, number>;
  layers: Record<string, number>;
  relationshipTypes: Record<string, number>;
  sites: Record<string, number>;
}

async function stats(positional: string[], flags: Flags): Promise<void> {
  const dir = resolve(process.cwd(), stringFlag(flags, 'dir', positional[0] ?? DEFAULT_OUT));
  const summaryPath = join(dir, SUMMARY_FILE);
  if (!existsSync(summaryPath)) throw new Error('no ' + SUMMARY_FILE + ' in ' + dir + '; run generate first');
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as StoredSummary;
  console.log(
    'synth-estate output at ' +
      dir +
      ' (seed ' +
      String(summary.seed) +
      ', scale ' +
      String(summary.scale) +
      ')',
  );
  console.log(
    table([
      ['CIs', summary.totals.cis],
      ['relationships', summary.totals.relationships],
      ['collector results', summary.totals.results],
      ['business services', summary.businessServices],
    ]),
  );
  console.log('files:');
  const rows: Array<[string, string]> = [];
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith(NDJSON_SUFFIX))
    .sort()) {
    const path = join(dir, name);
    const lines = await countLines(path);
    rows.push([
      name,
      String(lines) + ' results, ' + (statSync(path).size / BYTES_PER_MIB).toFixed(1) + ' MiB',
    ]);
  }
  console.log(table(rows));
  console.log('CI types:');
  console.log(table(recordRows(summary.ciTypes)));
  console.log('layers:');
  console.log(table(recordRows(summary.layers)));
  console.log('relationship types:');
  console.log(table(recordRows(summary.relationshipTypes)));
  console.log('sites:');
  console.log(table(recordRows(summary.sites)));
}

/** health-history: outages for every business service of a generated estate over the months before --now. */
function healthHistory(flags: Flags): void {
  const dir = resolve(process.cwd(), stringFlag(flags, 'dir', DEFAULT_OUT));
  const seed = numberFlag(flags, 'seed', DEFAULT_SEED);
  const months = numberFlag(flags, 'months', SLA.synthetic.months);
  const now = stringFlag(flags, 'now', new Date().toISOString());
  const services = JSON.parse(readFileSync(join(dir, SERVICES_FILE), 'utf8')) as BusinessServiceRecord[];
  const history = generateHealthHistory(services, seed, now, months);
  const out = join(dir, HEALTH_HISTORY_FILE);
  writeFileSync(out, JSON.stringify(history, null, 2) + '\n');
  console.log(
    table([
      ['services', services.length],
      ['months', months],
      ['outages', history.outages.length],
      ['down', history.outages.filter((o) => o.state === 'down').length],
      ['file', out],
    ]),
  );
}

const DEFAULT_HISTORY_DAYS = 14;
const DEFAULT_HISTORY_EVERY_HOURS = 6;
const COPIED_FILES = ['estate-summary.json', 'organization.json', 'services.json'];

/** Reads every result of an emitted estate and writes the utilisation history beside its summary in `--out`. */
function utilisation(flags: Flags): void {
  const dir = resolve(process.cwd(), stringFlag(flags, 'dir', DEFAULT_OUT));
  const out = resolve(process.cwd(), stringFlag(flags, 'out', join(dir, 'utilisation')));
  const seed = numberFlag(flags, 'seed', DEFAULT_SEED);
  const days = numberFlag(flags, 'days', DEFAULT_HISTORY_DAYS);
  const every = numberFlag(flags, 'every', DEFAULT_HISTORY_EVERY_HOURS);
  const now = stringFlag(flags, 'now', new Date().toISOString());
  const results: CollectorResult[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(NDJSON_SUFFIX)).sort())
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) if (line.trim() !== '') results.push(JSON.parse(line) as CollectorResult);
  const history = utilisationHistory(results, seed, now, days, every);
  mkdirSync(out, { recursive: true });
  for (const f of COPIED_FILES) if (existsSync(join(dir, f))) copyFileSync(join(dir, f), join(out, f));
  writeFileSync(join(out, UTILISATION_HISTORY_FILE), history.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(
    table([
      ['results', history.length],
      ['samples', history.reduce((n, r) => n + r.samples.length, 0)],
      ['days', days],
      ['every (hours)', every],
      ['dir', out],
    ]),
  );
}

/** REQ-DCIM-005: outlets as power_feed CIs, cords on their outlets, and PDU and outlet draw over recent days. */
function power(flags: Flags): void {
  const dir = resolve(process.cwd(), stringFlag(flags, 'dir', DEFAULT_OUT));
  const out = resolve(process.cwd(), stringFlag(flags, 'out', join(dir, 'power')));
  const seed = numberFlag(flags, 'seed', DEFAULT_SEED);
  const days = numberFlag(flags, 'days', DEFAULT_HISTORY_DAYS);
  const every = numberFlag(flags, 'every', DEFAULT_HISTORY_EVERY_HOURS);
  const now = stringFlag(flags, 'now', new Date().toISOString());
  const results: CollectorResult[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(NDJSON_SUFFIX)).sort())
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) if (line.trim() !== '') results.push(JSON.parse(line) as CollectorResult);
  // --structure-only: the outlets and the device-to-outlet cords without samples (for an estate that has its samples).
  const history = powerHistory(results, seed, now, days, every, flags['structure-only'] !== true);
  mkdirSync(out, { recursive: true });
  for (const f of COPIED_FILES) if (existsSync(join(dir, f))) copyFileSync(join(dir, f), join(out, f));
  writeFileSync(join(out, POWER_HISTORY_FILE), history.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(
    table([
      ['results', history.length],
      ['outlets', history.reduce((n, r) => n + r.cis.length, 0)],
      ['samples', history.reduce((n, r) => n + r.samples.length, 0)],
      ['days', days],
      ['every (hours)', every],
      ['dir', out],
    ]),
  );
}

/** REQ-DCIM-006: rack inlet and outlet temperature, room humidity and cooling units over recent days. */
function environment(flags: Flags): void {
  const dir = resolve(process.cwd(), stringFlag(flags, 'dir', DEFAULT_OUT));
  const out = resolve(process.cwd(), stringFlag(flags, 'out', join(dir, 'environment')));
  const seed = numberFlag(flags, 'seed', DEFAULT_SEED);
  const days = numberFlag(flags, 'days', DEFAULT_HISTORY_DAYS);
  const every = numberFlag(flags, 'every', DEFAULT_HISTORY_EVERY_HOURS);
  const now = stringFlag(flags, 'now', new Date().toISOString());
  const results: CollectorResult[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(NDJSON_SUFFIX)).sort())
    for (const line of readFileSync(join(dir, file), 'utf8').split(NEWLINE)) if (line.trim() !== '') results.push(JSON.parse(line) as CollectorResult);
  const history = environmentHistory(results, seed, now, days, every);
  mkdirSync(out, { recursive: true });
  for (const f of COPIED_FILES) if (existsSync(join(dir, f))) copyFileSync(join(dir, f), join(out, f));
  writeFileSync(join(out, ENVIRONMENT_HISTORY_FILE), history.map((r) => JSON.stringify(r)).join(NEWLINE) + NEWLINE);
  console.log(
    table([
      ['results', history.length],
      ['samples', history.reduce((n, r) => n + r.samples.length, 0)],
      ['days', days],
      ['every (hours)', every],
      ['dir', out],
    ]),
  );
}

function usage(): string {
  return [
    'usage:',
    '  synth generate [--seed N] [--scale F] [--out DIR]',
    '  synth stats [DIR|--dir DIR]',
    '  synth health-history [--dir DIR] [--seed N] [--months M] [--now ISO]',
    '  synth utilisation-history [--dir DIR] [--out DIR] [--seed N] [--days D] [--every H] [--now ISO]',
    '  synth power-history [--dir DIR] [--out DIR] [--seed N] [--days D] [--every H] [--now ISO] [--structure-only]',
    '  synth environment-history [--dir DIR] [--out DIR] [--seed N] [--days D] [--every H] [--now ISO]',
  ].join('\n');
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  switch (command) {
    case 'generate':
      await generate(flags);
      return;
    case 'stats':
      await stats(positional.slice(1), flags);
      return;
    case 'utilisation-history':
      utilisation(flags);
      break;
    case 'environment-history':
      environment(flags);
      break;
    case 'power-history':
      power(flags);
      break;
    case 'health-history':
      healthHistory(flags);
      return;
    default:
      console.error(usage());
      process.exit(command === undefined ? 0 : 1);
  }
}

main().catch((err: unknown) => {
  console.error('synth-estate: ' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
