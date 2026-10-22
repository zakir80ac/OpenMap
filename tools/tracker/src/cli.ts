// REQ-CORE-007 — tracker CLI (CLAUDE.md §3): init, add, set, status, next, report, verify, session.
import { writeFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PRIORITIES, REQ_STATUSES, REPO_PATHS, WORKSTREAMS, GUARD_HEADER_LINES, type ReqStatus, type Workstream } from '@openmap/constants';
import { readWorkbook, writeWorkbook, workbookExists } from './workbook.js';
import { loadSeeds, materialise, nextId, seedComponents, seedContracts, seedDecisions, seedRisks } from './seed.js';
import { today, type Requirement, type TrackerData } from './model.js';

const repoRoot = resolve(process.cwd(), '..', '..');
const trackerPath = join(repoRoot, REPO_PATHS.tracker);
const summaryPath = join(repoRoot, REPO_PATHS.trackerSummary);
const specPath = join(repoRoot, REPO_PATHS.spec);
const capabilityMapPath = join(repoRoot, 'docs', 'CAPABILITY-MAP.md');
const NEXT_COUNT = 3;

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

function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function fail(message: string): never {
  console.error('tracker: ' + message);
  process.exit(1);
}

async function load(): Promise<TrackerData> {
  if (!workbookExists(trackerPath)) fail('workbook not found at ' + trackerPath + '; run `pnpm tracker init`');
  return readWorkbook(trackerPath);
}

function priorityRank(r: Requirement): number {
  return PRIORITIES.indexOf(r.priority);
}

function unblocked(r: Requirement, all: Requirement[]): boolean {
  return r.dependsOn.every((dep) => all.find((x) => x.id === dep)?.status === 'Done');
}

function nextRequirements(data: TrackerData, count: number): Requirement[] {
  const inProgress = data.requirements.filter((r) => r.status === 'In progress');
  const candidates = data.requirements
    .filter((r) => r.status === 'Not started' && unblocked(r, data.requirements))
    .sort((a, b) => priorityRank(a) - priorityRank(b) || a.id.localeCompare(b.id));
  return [...inProgress, ...candidates].slice(0, count);
}

function printRequirement(r: Requirement): void {
  console.log(r.id + '  [' + r.priority + '] [' + r.status + ']  ' + r.title);
  console.log('   area: ' + r.capabilityArea + ' · spec: ' + r.specSection);
  console.log('   ' + r.description);
  console.log('   acceptance: ' + r.acceptanceCriteria);
  if (r.dependsOn.length) console.log('   depends on: ' + r.dependsOn.join(', '));
  if (r.testIds.length) console.log('   tests: ' + r.testIds.join(', '));
  if (r.evidence) console.log('   evidence: ' + r.evidence);
}

function statusCounts(data: TrackerData): Record<ReqStatus, number> {
  const out = Object.fromEntries(REQ_STATUSES.map((s) => [s, 0])) as Record<ReqStatus, number>;
  for (const r of data.requirements) out[r.status]++;
  return out;
}

async function cmdInit(): Promise<void> {
  const existing: TrackerData = workbookExists(trackerPath)
    ? await readWorkbook(trackerPath)
    : { requirements: [], components: [], contracts: [], decisions: [], risks: [], tests: [], sessions: [] };
  const seeds = loadSeeds(capabilityMapPath, specPath);
  const added = materialise(seeds, existing.requirements);
  existing.requirements.push(...added);
  if (existing.components.length === 0) existing.components = seedComponents();
  if (existing.contracts.length === 0) existing.contracts = seedContracts();
  if (existing.decisions.length === 0) existing.decisions = seedDecisions();
  if (existing.risks.length === 0) existing.risks = seedRisks();
  await writeWorkbook(trackerPath, existing);
  console.log('tracker: ' + String(added.length) + ' requirements added, ' + String(existing.requirements.length) + ' total');
  if (!existsSync(specPath)) console.log('tracker: docs/SPEC.md not found; rows seeded from CLAUDE.md, docs/CAPABILITY-MAP.md and the design canvas');
  for (const ws of WORKSTREAMS) console.log('  ' + ws.padEnd(5) + String(existing.requirements.filter((r) => r.workstream === ws).length).padStart(4));
}

async function cmdAdd(flags: Flags): Promise<void> {
  const data = await load();
  const ws = str(flags, 'ws');
  const title = str(flags, 'title');
  const ac = str(flags, 'ac');
  if (!ws || !WORKSTREAMS.includes(ws as Workstream)) fail('--ws must be one of ' + WORKSTREAMS.join(', '));
  if (!title) fail('--title is required');
  if (!ac) fail('--ac (acceptance criteria) is required');
  const priority = (str(flags, 'priority') ?? 'P1') as Requirement['priority'];
  if (!PRIORITIES.includes(priority)) fail('--priority must be P0, P1 or P2');
  const row: Requirement = {
    id: nextId(ws as Workstream, data.requirements),
    workstream: ws as Workstream,
    capabilityArea: str(flags, 'area') ?? 'Added',
    title,
    description: str(flags, 'desc') ?? '',
    acceptanceCriteria: ac,
    priority,
    status: 'Not started',
    owner: str(flags, 'owner') ?? '',
    dependsOn: (str(flags, 'depends') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    specSection: str(flags, 'spec') ?? '',
    testIds: [],
    evidence: '',
    created: today(),
    updated: today(),
    notes: str(flags, 'notes') ?? '',
  };
  data.requirements.push(row);
  await writeWorkbook(trackerPath, data);
  console.log('tracker: added ' + row.id);
}

async function cmdSet(positional: string[], flags: Flags): Promise<void> {
  const id = positional[0];
  if (!id) fail('usage: tracker set REQ-xxx --status ... [--owner] [--tests] [--evidence] [--notes]');
  const data = await load();
  const row = data.requirements.find((r) => r.id === id);
  if (!row) fail('unknown requirement ' + id);
  const status = str(flags, 'status');
  if (status !== undefined) {
    if (!REQ_STATUSES.includes(status as ReqStatus)) fail('--status must be one of ' + REQ_STATUSES.join(', '));
    row.status = status as ReqStatus;
  }
  const owner = str(flags, 'owner');
  if (owner !== undefined) row.owner = owner;
  const tests = str(flags, 'tests');
  if (tests !== undefined) row.testIds = [...new Set([...row.testIds, ...tests.split(',').map((s) => s.trim()).filter(Boolean)])];
  const evidence = str(flags, 'evidence');
  if (evidence !== undefined) row.evidence = row.evidence ? row.evidence + '; ' + evidence : evidence;
  const notes = str(flags, 'notes');
  if (notes !== undefined) row.notes = notes;
  if (row.status === 'Done' && (row.testIds.length === 0 || row.evidence === '')) fail(id + ' cannot be Done without --tests and --evidence');
  row.updated = today();
  for (const t of row.testIds) {
    const existing = data.tests.find((x) => x.id === t);
    if (existing) {
      if (!existing.covers.includes(id)) existing.covers.push(id);
    } else data.tests.push({ id: t, type: 'unit', covers: [id], lastRun: today(), result: 'Pass', durationMs: 0 });
  }
  await writeWorkbook(trackerPath, data);
  console.log('tracker: ' + id + ' → ' + row.status);
}

async function cmdStatus(): Promise<void> {
  const data = await load();
  const counts = statusCounts(data);
  const total = data.requirements.length;
  console.log('OpenMap tracker · ' + String(total) + ' requirements');
  for (const s of REQ_STATUSES) console.log('  ' + s.padEnd(12) + String(counts[s]).padStart(5));
  const done = counts.Done;
  console.log('  ' + 'complete'.padEnd(12) + (total ? String(Math.round((done / total) * 100)) : '0').padStart(4) + '%');
  console.log('');
  console.log('By workstream:');
  for (const ws of WORKSTREAMS) {
    const rs = data.requirements.filter((r) => r.workstream === ws);
    const d = rs.filter((r) => r.status === 'Done').length;
    const ip = rs.filter((r) => r.status === 'In progress').length;
    console.log('  ' + ws.padEnd(5) + String(rs.length).padStart(4) + ' total ' + String(d).padStart(4) + ' done ' + String(ip).padStart(3) + ' in progress');
  }
  console.log('');
  console.log('Next ' + String(NEXT_COUNT) + ':');
  for (const r of nextRequirements(data, NEXT_COUNT)) console.log('  ' + r.id + ' [' + r.priority + '] ' + r.title);
}

async function cmdNext(): Promise<void> {
  const data = await load();
  const [r] = nextRequirements(data, 1);
  if (!r) {
    console.log('tracker: nothing unblocked');
    return;
  }
  printRequirement(r);
}

function summaryMarkdown(data: TrackerData): string {
  const counts = statusCounts(data);
  const total = data.requirements.length;
  const lines: string[] = [];
  lines.push('# OpenMap tracker summary');
  lines.push('');
  lines.push('Generated ' + new Date().toISOString() + ' from `tracker/OpenMap-Tracker.xlsx`. Do not edit; run `pnpm tracker report`.');
  lines.push('');
  lines.push('| Status | Count |');
  lines.push('| --- | ---: |');
  for (const s of REQ_STATUSES) lines.push('| ' + s + ' | ' + String(counts[s]) + ' |');
  lines.push('| **Total** | **' + String(total) + '** |');
  lines.push('');
  lines.push('## By workstream');
  lines.push('');
  lines.push('| Workstream | Total | Done | In progress | Blocked | % done |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const ws of WORKSTREAMS) {
    const rs = data.requirements.filter((r) => r.workstream === ws);
    const d = rs.filter((r) => r.status === 'Done').length;
    lines.push('| ' + ws + ' | ' + String(rs.length) + ' | ' + String(d) + ' | ' + String(rs.filter((r) => r.status === 'In progress').length) + ' | ' + String(rs.filter((r) => r.status === 'Blocked').length) + ' | ' + (rs.length ? String(Math.round((d / rs.length) * 100)) : '0') + '% |');
  }
  lines.push('');
  lines.push('## In progress');
  lines.push('');
  for (const r of data.requirements.filter((r) => r.status === 'In progress')) lines.push('- ' + r.id + ' · ' + r.title);
  lines.push('');
  lines.push('## Blocked');
  lines.push('');
  for (const r of data.requirements.filter((r) => r.status === 'Blocked')) lines.push('- ' + r.id + ' · ' + r.title + (r.notes ? ' — ' + r.notes : ''));
  lines.push('');
  lines.push('## Next up');
  lines.push('');
  for (const r of nextRequirements(data, 10)) lines.push('- ' + r.id + ' [' + r.priority + '] ' + r.title);
  lines.push('');
  lines.push('## Open risks');
  lines.push('');
  for (const r of data.risks.filter((r) => r.status !== 'Closed')) lines.push('- ' + r.id + ' (' + r.likelihood + '/' + r.impact + ') ' + r.risk);
  lines.push('');
  return lines.join('\n');
}

async function cmdReport(): Promise<void> {
  const data = await load();
  await writeWorkbook(trackerPath, data);
  writeFileSync(summaryPath, summaryMarkdown(data));
  console.log('tracker: Dashboard regenerated; ' + REPO_PATHS.trackerSummary + ' written');
}

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next' || entry === '.turbo') continue;
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

const SOURCE_EXT = /\.(ts|tsx|go|py)$/;
const TEST_FILE = /(\.test\.|\.spec\.|__tests__|_test\.go)/;

async function cmdVerify(): Promise<void> {
  const data = await load();
  const problems: string[] = [];
  for (const r of data.requirements) {
    if (r.status === 'Done' && (r.testIds.length === 0 || r.evidence === '')) problems.push(r.id + ' is Done without test IDs or evidence');
    for (const dep of r.dependsOn) if (!data.requirements.find((x) => x.id === dep)) problems.push(r.id + ' depends on unknown ' + dep);
  }
  const ids = new Set(data.requirements.map((r) => r.id));
  const appsDir = join(repoRoot, 'apps');
  for (const file of walk(appsDir)) {
    if (!SOURCE_EXT.test(file) || TEST_FILE.test(file)) continue;
    const head = readFileSync(file, 'utf8').split(/\r?\n/).slice(0, GUARD_HEADER_LINES).join('\n');
    const refs = head.match(/REQ-[A-Z]+-\d{3}/g) ?? [];
    if (refs.length === 0) problems.push(file.slice(repoRoot.length + 1) + ' has no REQ id in its header');
    for (const ref of refs) if (!ids.has(ref)) problems.push(file.slice(repoRoot.length + 1) + ' references unknown ' + ref);
  }
  if (problems.length) {
    for (const p of problems) console.error('tracker verify: ' + p);
    process.exit(1);
  }
  console.log('tracker verify: ok (' + String(data.requirements.length) + ' rows)');
}

async function cmdSession(flags: Flags): Promise<void> {
  const data = await load();
  const summary = str(flags, 'summary');
  if (!summary) fail('--summary is required');
  data.sessions.push({
    date: today(),
    summary,
    reqsTouched: (str(flags, 'reqs') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    commits: (str(flags, 'commits') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    blockers: str(flags, 'blockers') ?? '',
  });
  await writeWorkbook(trackerPath, data);
  console.log('tracker: session recorded');
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;
  switch (command) {
    case 'init':
      return cmdInit();
    case 'add':
      return cmdAdd(flags);
    case 'set':
      return cmdSet(rest, flags);
    case 'status':
      return cmdStatus();
    case 'next':
      return cmdNext();
    case 'report':
      return cmdReport();
    case 'verify':
      return cmdVerify();
    case 'session':
      return cmdSession(flags);
    default:
      fail('usage: tracker <init|add|set|status|next|report|verify|session>');
  }
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
