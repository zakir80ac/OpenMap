// REQ-AI-007 (ADR-028) — level one of the conversation: understand. A question is normalised and read against the
// vocabulary (intent markers, CI types, attribute families, measurements, aggregates, grouping, names, scope words,
// health, periods). The result is a classification with the terms that produced it, so the evidence on the answer
// can show why a question was read as a count of hosts per site rather than a lookup. Deterministic; the model is
// consulted only when this leaves the intent unknown or the confidence low.
import { ASSISTANT, type Locale } from '@openmap/constants';
import type { AssistantAggregate, AssistantIntent, CiType, HealthState } from '@openmap/contracts';
import {
  AGGREGATE_TERMS,
  ATTRIBUTE_FAMILIES,
  FILTER_MARKERS,
  GROUP_TERMS,
  HEALTH_TERMS,
  INTENT_TERMS,
  MEASUREMENTS,
  NAME_MARKERS,
  PERIODS,
  TYPE_TERMS,
  isArabic,
  maskSpan,
  matchCatalogue,
  matchTerms,
  normalise,
  rangeOf,
  type AttributeFamilyId,
  type MeasurementName,
  type PeriodSpec,
  type RangeSpec,
  type TermHit,
} from './vocabulary.js';

export type GroupBy = { kind: 'attribute'; family: AttributeFamilyId } | { kind: 'type'; type: CiType };

export interface Entities {
  /** CI types in order of appearance; the first is the subject of the question. */
  types: CiType[];
  attribute: AttributeFamilyId | null;
  measurement: MeasurementName | null;
  aggregate: AssistantAggregate | null;
  groupBy: GroupBy | null;
  /** Candidate CI names or codes: quoted text, code-like tokens, the word after "named". */
  names: string[];
  /** Scope words after "in", "on", "at": a site, a platform, a cluster; resolved against the tenant's values. */
  filters: string[];
  health: HealthState | null;
  period: PeriodSpec | null;
  /** REQ-AI-008: a rolling window ("over the last 7 days") that turns a measurement question into a series. */
  range: RangeSpec | null;
  /** "top 5": how many rows a ranking should list. */
  topN: number | null;
}

export interface Classification {
  intent: AssistantIntent;
  /** 0..1; below ASSISTANT.minIntentConfidence the model is asked, then the person. */
  confidence: number;
  locale: Locale;
  entities: Entities;
  /** The vocabulary terms that matched, for the evidence. */
  matched: string[];
  normalised: string;
}

/** Words that never carry a name or a scope value. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the',
  'a',
  'an',
  'each',
  'every',
  'all',
  'our',
  'my',
  'this',
  'that',
  'these',
  'those',
  'of',
  'for',
  'to',
  'and',
  'or',
  'with',
  'is',
  'are',
  'do',
  'does',
  'did',
  'have',
  'has',
  'we',
  'i',
  'you',
  'it',
  'there',
  'which',
  'what',
  'who',
  'where',
  'when',
  'how',
  'many',
  'much',
  'any',
  'some',
  'list',
  'show',
  'give',
  'me',
  'please',
  'estate',
  'running',
  'run',
  'runs',
  'كل',
  'في',
  'من',
  'على',
  'الى',
  'إلى',
  'عن',
  'مع',
  'هل',
  'ما',
  'ماذا',
  'اي',
  'أي',
  'التي',
  'الذي',
  'هذا',
  'هذه',
  'لدينا',
  'عندنا',
  'لي',
  'لنا',
  'اعرض',
  'أعرض',
  'اظهر',
  'أظهر',
]);

/** Something that looks like an identifier: a token with a letter that also carries a digit, dash, dot or underscore. */
const CODE_LIKE = new RegExp('^[a-z0-9][a-z0-9._-]*$');
const HAS_LETTER = new RegExp('[a-z]');
const HAS_DIGIT = new RegExp('[0-9._-]');
const QUOTED = new RegExp('["“”«»\'‘’]([^"“”«»\'‘’]{2,})["“”«»\'‘’]', 'g');
const TOP_N = new RegExp('(?:^|\\s)(?:top|first|اعلى|أعلى|اكبر|أكبر|اول|أول)\\s+([0-9]+)(?:\\s|$)');

const CONFIDENCE = ASSISTANT.intentConfidence;

function tokensOf(text: string): string[] {
  return text.split(' ').filter((t) => t.length > 0);
}

/** Catalogue entries in order of first appearance, each masked out of the working text so shorter terms do not re-match. */
function typesInOrder(text: string): {
  types: CiType[];
  masked: string;
  matched: string[];
  found: Array<{ type: CiType; index: number; term: string }>;
} {
  let working = text;
  const found: Array<{ type: CiType; index: number; term: string }> = [];
  // Longest terms first: "esxi host" is a hypervisor and must blank "host" before the host terms run.
  for (;;) {
    const hits = matchCatalogue(working, TYPE_TERMS);
    const first = hits[0];
    if (first === undefined) break;
    found.push({ type: first.key, index: first.hit.index, term: first.hit.term });
    working = maskSpan(working, first.hit);
  }
  found.sort((a, b) => a.index - b.index);
  const types: CiType[] = [];
  for (const f of found) if (!types.includes(f.type)) types.push(f.type);
  return { types, masked: working, matched: found.map((f) => f.term), found };
}

function groupByOf(
  text: string,
  subject: CiType | null,
): { groupBy: GroupBy | null; matched: string[]; attributeHit: TermHit | null } {
  const marker = matchTerms(text, GROUP_TERMS);
  if (marker === null) return { groupBy: null, matched: [], attributeHit: null };
  const offset = marker.start + marker.length;
  const after = text.slice(offset);
  const attribute = matchCatalogue(after, ATTRIBUTE_FAMILIES)[0];
  const type = matchCatalogue(after, TYPE_TERMS)[0];
  if (attribute !== undefined && (type === undefined || attribute.hit.index <= type.hit.index)) {
    // The hit is reported at its offset in the whole text so callers can match it against other hits.
    return {
      groupBy: { kind: 'attribute', family: attribute.key },
      matched: [marker.term, attribute.hit.term],
      attributeHit: { ...attribute.hit, index: attribute.hit.index + offset, start: attribute.hit.start + offset },
    };
  }
  if (type !== undefined) {
    // "OS per server": the group is the subject itself, so the question is a distribution of the attribute, not a fan-out.
    if (type.key === subject)
      return { groupBy: null, matched: [marker.term, type.hit.term], attributeHit: null };
    return {
      groupBy: { kind: 'type', type: type.key },
      matched: [marker.term, type.hit.term],
      attributeHit: null,
    };
  }
  return { groupBy: null, matched: [marker.term], attributeHit: null };
}

function wordAfter(text: string, hit: TermHit): string | null {
  const rest = tokensOf(text.slice(hit.start + hit.length));
  const word = rest[0];
  return word !== undefined && !STOP_WORDS.has(word) ? word : null;
}

function namesOf(original: string, normalised: string, consumed: ReadonlySet<string>): string[] {
  const names: string[] = [];
  for (const m of original.matchAll(QUOTED)) {
    const quoted = (m[1] ?? '').trim();
    if (quoted.length > 0) names.push(quoted);
  }
  for (const token of tokensOf(normalised)) {
    if (consumed.has(token) || STOP_WORDS.has(token)) continue;
    if (
      CODE_LIKE.test(token) &&
      HAS_LETTER.test(token) &&
      HAS_DIGIT.test(token) &&
      !names.some((n) => normalise(n) === token)
    )
      names.push(token);
  }
  const marker = matchTerms(normalised, NAME_MARKERS);
  if (marker !== null) {
    const word = wordAfter(normalised, marker);
    if (word !== null && !names.some((n) => normalise(n) === word)) names.push(word);
  }
  return names;
}

function filtersOf(normalised: string, consumed: ReadonlySet<string>, names: readonly string[]): string[] {
  const out: string[] = [];
  const normalisedNames = new Set(names.map((n) => normalise(n)));
  let working = normalised;
  for (;;) {
    const marker = matchTerms(working, FILTER_MARKERS);
    if (marker === null) break;
    const word = wordAfter(working, marker);
    working = working.slice(marker.start + marker.length);
    if (word === null || consumed.has(word) || normalisedNames.has(word) || out.includes(word)) continue;
    if (matchTerms(word, GROUP_TERMS) !== null) continue;
    out.push(word);
  }
  return out;
}

export function intentMarker(text: string): { intent: AssistantIntent; term: string } | null {
  // Order matters: "how do I export the uptime report" is a how-to before it is a report or availability question.
  const order: Array<keyof typeof INTENT_TERMS> = [
    'howto',
    'report',
    'anomalies',
    'impact',
    'incidents',
    'availability',
    'history',
  ];
  for (const intent of order) {
    const hit = matchTerms(text, INTENT_TERMS[intent]);
    if (hit !== null) return { intent, term: hit.term };
  }
  return null;
}

function healthOf(text: string): { health: HealthState | null; term: string | null } {
  for (const state of ['down', 'degraded', 'healthy'] as const) {
    const hit = matchTerms(text, HEALTH_TERMS[state]);
    if (hit !== null) return { health: state, term: hit.term };
  }
  return { health: null, term: null };
}

function periodOf(text: string): { period: PeriodSpec | null; term: string | null } {
  for (const spec of Object.values(PERIODS)) {
    const hit = matchTerms(text, spec.terms);
    if (hit !== null) return { period: spec, term: hit.term };
  }
  return { period: null, term: null };
}

/** The measurement whose subjects include the subject type, else the first match; the subject follows the metric. */
function measurementOf(
  text: string,
  types: CiType[],
): { measurement: MeasurementName | null; subject: CiType | null; term: string | null } {
  const hits = matchCatalogue(text, MEASUREMENTS);
  if (hits.length === 0) return { measurement: null, subject: null, term: null };
  const subject = types[0] ?? null;
  const fitting =
    subject === null
      ? undefined
      : hits.find((h) => (MEASUREMENTS[h.key].subjects as readonly CiType[]).includes(subject));
  const chosen = fitting ?? hits[0];
  if (chosen === undefined) return { measurement: null, subject: null, term: null };
  const impliedSubject: CiType =
    subject !== null && fitting !== undefined ? subject : MEASUREMENTS[chosen.key].subjects[0];
  return { measurement: chosen.key, subject: impliedSubject, term: chosen.hit.term };
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export function classify(question: string): Classification {
  const normalised = normalise(question);
  const locale: Locale = isArabic(question) ? 'ar' : 'en';
  const matched: string[] = [];
  const consumed = new Set<string>();
  const remember = (term: string | null): void => {
    if (term === null) return;
    matched.push(term);
    for (const t of tokensOf(normalise(term))) consumed.add(t);
  };

  const marker = intentMarker(normalised);
  remember(marker?.term ?? null);

  const typed = typesInOrder(normalised);
  typed.matched.forEach(remember);
  let types = typed.types;

  const measured = measurementOf(normalised, types);
  remember(measured.term);
  if (measured.subject !== null && !types.includes(measured.subject)) types = [measured.subject, ...types];

  const attributeHits = matchCatalogue(typed.masked, ATTRIBUTE_FAMILIES);
  const grouped = groupByOf(normalised, types[0] ?? null);
  grouped.matched.forEach(remember);
  // "per site" groups by the site attribute; the word is not a second subject ("and per site?" after a host count).
  if (grouped.attributeHit !== null) {
    const groupedIndex = grouped.attributeHit.index;
    types = types.filter((type) => !typed.found.some((f) => f.type === type && f.index === groupedIndex));
  }
  // The attribute named after "per"/"by" is the grouping, not the measured attribute.
  const attributeHit =
    attributeHits.find((h) => grouped.attributeHit === null || h.hit.index !== grouped.attributeHit.index) ??
    null;
  remember(attributeHit?.hit.term ?? null);

  const aggregateHit = matchCatalogue(normalised, AGGREGATE_TERMS)[0] ?? null;
  remember(aggregateHit?.hit.term ?? null);

  const health = healthOf(normalised);
  remember(health.term);
  const period = periodOf(normalised);
  remember(period.term);
  const range = rangeOf(normalised);
  remember(range?.term ?? null);
  const topMatch = TOP_N.exec(normalised);
  const topN = topMatch?.[1] !== undefined ? Number(topMatch[1]) : null;

  const names = namesOf(question, normalised, consumed);
  const filters = filtersOf(normalised, consumed, names);

  const entities: Entities = {
    types,
    attribute: attributeHit?.key ?? null,
    measurement: measured.measurement,
    aggregate: aggregateHit?.key ?? null,
    groupBy: grouped.groupBy,
    names,
    filters,
    health: health.health,
    period: period.period,
    range,
    topN,
  };
  const derived = deriveIntent(entities, marker?.intent ?? null);
  return { intent: derived.intent, confidence: derived.confidence, locale, entities, matched, normalised };
}

/**
 * The intent the entities support and the confidence of that reading: an intent marker wins, then a measurement,
 * then an attribute on a subject, then a count, then a bare lookup. Shared with the follow-up resolution of
 * REQ-AI-008, which re-derives the intent from the entities merged with the previous turn's.
 */
export function deriveIntent(
  entities: Entities,
  marker: AssistantIntent | null,
): { intent: AssistantIntent; confidence: number } {
  let intent: AssistantIntent;
  let confidence: number = CONFIDENCE.base;
  const subject = entities.types[0] ?? null;
  if (marker !== null) {
    intent = marker;
    confidence += CONFIDENCE.marker;
  } else if (entities.measurement !== null) {
    intent = 'measurement';
    confidence += CONFIDENCE.measurement;
  } else if (entities.attribute !== null && subject !== null) {
    intent = 'attribute_stats';
    confidence += CONFIDENCE.attribute;
  } else if (entities.aggregate === 'count' && (subject !== null || entities.groupBy !== null)) {
    intent = 'count';
    confidence += CONFIDENCE.aggregate;
  } else if (entities.groupBy !== null && subject !== null) {
    intent = 'count';
    confidence += CONFIDENCE.aggregate;
  } else if (subject !== null || entities.names.length > 0) {
    intent = 'lookup';
  } else {
    intent = 'unknown';
  }
  if (subject !== null) confidence += CONFIDENCE.type;
  if (entities.names.length > 0) confidence += CONFIDENCE.name;
  if (entities.aggregate !== null && intent !== 'count') confidence += CONFIDENCE.aggregate;
  if (intent === 'unknown')
    confidence = Math.min(confidence, ASSISTANT.minIntentConfidence - CONFIDENCE.aggregate);
  return { intent, confidence: clamp(confidence) };
}
