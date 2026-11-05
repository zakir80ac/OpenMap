// REQ-AI-007 (ADR-028) — the grounding guard. The model may word an answer, never invent one: every number in its
// prose must be a figure the skills returned (at any rounding), every identifier-like token must be a CI the
// evidence names, and the prose must stay within the sentence budget. Anything else is rejected and the
// deterministic composition is used, with `grounded: false` on the answer so the console can say so.
import { ASSISTANT } from '@openmap/constants';
import type { AssistantFigure } from '@openmap/contracts';
import { asciiDigits, normalise } from './vocabulary.js';

export interface GuardVerdict {
  ok: boolean;
  /** Why the prose was rejected, for the failure log; null when accepted. */
  reason: string | null;
}

const NUMBER = new RegExp('[0-9]+(?:[.,][0-9]+)*', 'g');
const THOUSANDS = new RegExp(',(?=[0-9]{3}(?:[^0-9]|$))', 'g');
const CODE_TOKEN = new RegExp(
  '(^|\\s)([a-z0-9]*(?:[a-z][0-9]|[0-9][a-z]|[a-z0-9][._-][a-z0-9])[a-z0-9._-]*)(?=\\s|$)',
  'g',
);
const SENTENCE_END = new RegExp('[.!?؟](?:\\s|$)', 'g');
const HAS_LETTER = new RegExp('[a-z]');
const DECIMAL_BASE = ASSISTANT.decimalBase;

/** Numbers in a text, Arabic-Indic digits included, with thousands separators removed. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of asciiDigits(text).matchAll(NUMBER)) {
    const cleaned = m[0].replace(THOUSANDS, '').replace(',', '.');
    const n = Number(cleaned);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function roundings(value: number): number[] {
  const out = [value];
  for (let d = 0; d <= ASSISTANT.decimals; d++) {
    const factor = DECIMAL_BASE ** d;
    out.push(Math.round(value * factor) / factor);
  }
  return out;
}

/** A prose number is grounded when some allowed value, at some rounding, equals it. */
export function isAllowedNumber(n: number, allowed: ReadonlySet<number>): boolean {
  for (const a of allowed) if (roundings(a).some((r) => r === n)) return true;
  return false;
}

function numbersFromRows(rows: ReadonlyArray<Record<string, unknown>>): number[] {
  const out: number[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    else if (typeof v === 'string') out.push(...numbersIn(v));
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v !== null && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(visit);
  };
  rows.forEach(visit);
  return out;
}

export function sentenceCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  const ends = [...trimmed.matchAll(SENTENCE_END)].length;
  return Math.max(1, ends + (new RegExp('[.!?؟]$').test(trimmed) ? 0 : 1));
}

export interface GroundingContext {
  figures: readonly AssistantFigure[];
  rows: ReadonlyArray<Record<string, unknown>>;
  /** CI names, codes and other identifiers the evidence contains. */
  names: readonly string[];
  /** The question itself: a number or identifier the person typed may be repeated. */
  question: string;
}

/** Accepts prose only when every number and identifier in it traces to the evidence. */
export function checkGrounding(prose: string, context: GroundingContext): GuardVerdict {
  if (prose.trim().length === 0) return { ok: false, reason: 'empty prose' };
  if (sentenceCount(prose) > ASSISTANT.maxProseSentences) return { ok: false, reason: 'too many sentences' };
  // Identifiers first: the digits inside "web-77" belong to the name, not to the figures.
  const allowedTokens = new Set<string>();
  for (const source of [...context.names, context.question, ...context.figures.map((f) => f.label)])
    for (const t of normalise(source).split(' ')) if (t.length > 0) allowedTokens.add(t);
  for (const name of context.names) allowedTokens.add(normalise(name));
  // Punctuation is kept here so "2,000" stays one number; identifier tokens are blanked before the numbers are read.
  let withoutIdentifiers = asciiDigits(prose).toLowerCase();
  for (const m of normalise(prose).matchAll(CODE_TOKEN)) {
    const [, , token = ''] = m;
    if (token.length === 0 || !HAS_LETTER.test(token)) continue;
    if (!allowedTokens.has(token))
      return { ok: false, reason: 'identifier ' + token + ' is not in the evidence' };
    withoutIdentifiers = withoutIdentifiers.replace(
      new RegExp(
        '(^|[^a-z0-9._-])' +
          token.replace(new RegExp('[.*+?^${}()|[\\]\\\\]', 'g'), '\\$&') +
          '(?=[^a-z0-9._-]|$)',
      ),
      '$1 ',
    );
  }
  const allowedNumbers = new Set<number>([
    ...context.figures.map((f) => f.value),
    ...numbersFromRows(context.rows),
    ...numbersIn(context.question),
    ...context.figures.flatMap((f) => numbersIn(f.label)),
  ]);
  for (const n of numbersIn(withoutIdentifiers)) {
    if (!isAllowedNumber(n, allowedNumbers))
      return { ok: false, reason: 'number ' + String(n) + ' is not in the evidence' };
  }
  return { ok: true, reason: null };
}
