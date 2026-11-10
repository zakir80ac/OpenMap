// REQ-CORE-007 — the Decisions and Contracts sheets (CLAUDE.md §3): a decision row is read from its ADR's header in
// docs/adr, a contract row records the version a contract moved to and the ADR that moved it. Both are upserts keyed
// by ADR number and contract name, so a later record replaces an earlier one instead of adding a second row.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { componentSchema, decisionSchema, contractRowSchema, type Component, type ContractRow, type Decision } from './model.js';

/** How many header lines of an ADR carry its title, status and date (a long status wraps onto the next line). */
const ADR_HEADER_LINES = 6;
const ADR_ID = /^ADR-\d{3}$/;
const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const DECISION_STATUSES = decisionSchema.shape.status.options;

export type DecisionStatus = Decision['status'];

/** The ADR file for an ADR number in the ADR directory, as a path relative to the repository root. */
export function adrFile(adrDir: string, relDir: string, adr: string): string | undefined {
  if (!existsSync(adrDir)) return undefined;
  const name = readdirSync(adrDir).find((f) => f.startsWith(adr + '-') && f.endsWith('.md'));
  return name === undefined ? undefined : relDir + '/' + name;
}

/** Title, status and date from an ADR's header: `# ADR-045 — Title`, then `Status: Accepted … · Date: 2026-11-07`. */
export function parseAdrHeader(adr: string, text: string): { title: string; status: DecisionStatus | undefined; date: string | undefined } {
  const lines = text.split(/\r?\n/).slice(0, ADR_HEADER_LINES);
  const heading = lines.find((l) => l.startsWith('# '));
  const title = (heading ?? '').replace(/^#\s+/, '').replace(new RegExp('^' + adr + '\\s*[—:-]\\s*'), '').trim();
  const header = lines.join(' ');
  const statusText = /Status:\s*([A-Za-z]+)/.exec(header)?.[1];
  const status = DECISION_STATUSES.find((s) => s.toLowerCase() === statusText?.toLowerCase());
  const date = /Date:\s*([0-9-]+)/.exec(header)?.[1];
  return { title, status, date: date !== undefined && ISO_DATE.test(date) ? date : undefined };
}

export interface DecisionInput {
  adr: string;
  title?: string | undefined;
  status?: string | undefined;
  date?: string | undefined;
  link?: string | undefined;
}

/**
 * The Decisions row for an ADR: fields given on the command line win, the rest come from the ADR's header, then from
 * the existing row. Throws when a field is still missing or invalid.
 */
export function decisionRow(input: DecisionInput, fromFile: ReturnType<typeof parseAdrHeader> | undefined, existing: Decision | undefined, today: string): Decision {
  if (!ADR_ID.test(input.adr)) throw new Error('ADR number must look like ADR-045, got ' + input.adr);
  const row = {
    adr: input.adr,
    title: input.title ?? (fromFile?.title || undefined) ?? existing?.title ?? '',
    status: input.status ?? fromFile?.status ?? existing?.status ?? '',
    date: input.date ?? fromFile?.date ?? existing?.date ?? today,
    link: input.link ?? existing?.link ?? '',
  };
  if (row.date !== '' && !ISO_DATE.test(row.date)) throw new Error('--date must be YYYY-MM-DD, got ' + row.date);
  const parsed = decisionSchema.safeParse(row);
  if (!parsed.success) throw new Error(input.adr + ': ' + parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; '));
  return parsed.data;
}

/** Inserts or replaces a decision, keeping the sheet in ADR order. */
export function upsertDecision(rows: Decision[], row: Decision): Decision[] {
  return [...rows.filter((r) => r.adr !== row.adr), row].sort((a, b) => a.adr.localeCompare(b.adr));
}

export interface ContractInput {
  name: string;
  version?: string | undefined;
  file?: string | undefined;
  adr?: string | undefined;
  frozenOn?: string | undefined;
}

/** The Contracts row for a contract: a new contract needs its file and version; an existing one keeps what is not given. */
export function contractRow(input: ContractInput, existing: ContractRow | undefined): ContractRow {
  const row = {
    name: input.name,
    file: input.file ?? existing?.file ?? '',
    version: input.version ?? existing?.version ?? '',
    frozenOn: input.frozenOn ?? existing?.frozenOn ?? '',
    lastAdr: input.adr ?? existing?.lastAdr ?? '',
  };
  if (!SEMVER.test(row.version)) throw new Error(input.name + ': --version must be x.y.z, got ' + (row.version || 'nothing'));
  if (row.frozenOn !== '' && !ISO_DATE.test(row.frozenOn)) throw new Error(input.name + ': --frozen must be YYYY-MM-DD, got ' + row.frozenOn);
  if (row.lastAdr !== '' && !ADR_ID.test(row.lastAdr)) throw new Error(input.name + ': --adr must look like ADR-045, got ' + row.lastAdr);
  const parsed = contractRowSchema.safeParse(row);
  if (!parsed.success) throw new Error(input.name + ': ' + parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; '));
  return parsed.data;
}

/** Inserts or replaces a contract, keeping existing rows in place and appending a new one. */
export function upsertContract(rows: ContractRow[], row: ContractRow): ContractRow[] {
  return rows.some((r) => r.name === row.name) ? rows.map((r) => (r.name === row.name ? row : r)) : [...rows, row];
}

export interface ComponentInput {
  name: string;
  layer?: string | undefined;
  version?: string | undefined;
  licence?: string | undefined;
  runsAs?: string | undefined;
  airGap?: string | undefined;
  replacedBy?: string | undefined;
}

/** The Components row: a new component needs every field; an existing one keeps what is not given. */
export function componentRow(input: ComponentInput, existing: Component | undefined): Component {
  const parsed = componentSchema.safeParse({
    name: input.name,
    layer: input.layer ?? existing?.layer,
    versionPinned: input.version ?? existing?.versionPinned,
    licence: input.licence ?? existing?.licence,
    runsAs: input.runsAs ?? existing?.runsAs,
    airGapReady: input.airGap ?? existing?.airGapReady,
    replacedByOption: input.replacedBy ?? existing?.replacedByOption ?? '',
  });
  if (!parsed.success) throw new Error(input.name + ': ' + parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; '));
  return parsed.data;
}

/** Inserts or replaces a component by name, keeping the sheet's order. */
export function upsertComponent(rows: Component[], row: Component): Component[] {
  return rows.some((r) => r.name === row.name) ? rows.map((r) => (r.name === row.name ? row : r)) : [...rows, row];
}

/** Reads an ADR file's header, or undefined when the file does not exist. */
export function readAdrHeader(repoRoot: string, link: string, adr: string): ReturnType<typeof parseAdrHeader> | undefined {
  const path = join(repoRoot, link);
  return existsSync(path) ? parseAdrHeader(adr, readFileSync(path, 'utf8')) : undefined;
}
