// REQ-AI-008 (ADR-028) — a conversation remembers what the last turn was about. A follow-up ("and last month?",
// "and for VMs?", "وماذا عن الشهر الماضي؟") carries only what changed; the rest is filled from the previous turn's
// resolved reading, and the intent is derived again from the merged entities with the same ladder the classifier
// uses. Deterministic and unit-tested; the API persists the reading on every turn and hands the last one back here.
import { ASSISTANT } from '@openmap/constants';
import { ASSISTANT_INTENTS, CI_TYPES, HEALTH_STATES, type AssistantIntent, type CiType } from '@openmap/contracts';
import { z } from 'zod';
import { deriveIntent, intentMarker, type Classification, type Entities } from './intent.js';
import {
  ATTRIBUTE_FAMILIES,
  MEASUREMENTS,
  PERIODS,
  startsWithContinuation,
  type MeasurementName,
} from './vocabulary.js';

/** What a turn resolved to; persisted with the answer so the next turn can fill its gaps from it. */
export interface TurnContext {
  intent: AssistantIntent;
  entities: Entities;
}

const familyIds = Object.keys(ATTRIBUTE_FAMILIES) as [string, ...string[]];
const measurementNames = Object.keys(MEASUREMENTS) as [string, ...string[]];
const periodSchema = z.object({
  granularity: z.enum(['month', 'quarter', 'year']),
  back: z.number().int().nonnegative(),
  terms: z.object({ en: z.array(z.string()), ar: z.array(z.string()) }),
});

/** The persisted reading, checked on the way back from the database; a row written by an older build is ignored. */
export const turnContextSchema = z.object({
  intent: z.enum(ASSISTANT_INTENTS),
  entities: z.object({
    types: z.array(z.enum(CI_TYPES)),
    attribute: z.enum(familyIds).nullable(),
    measurement: z.enum(measurementNames).nullable(),
    aggregate: z.enum(['count', 'avg', 'sum', 'min', 'max', 'distribution']).nullable(),
    groupBy: z
      .union([
        z.object({ kind: z.literal('attribute'), family: z.enum(familyIds) }),
        z.object({ kind: z.literal('type'), type: z.enum(CI_TYPES) }),
      ])
      .nullable(),
    names: z.array(z.string()),
    filters: z.array(z.string()),
    health: z.enum(HEALTH_STATES).nullable(),
    period: periodSchema.nullable(),
    range: z.object({ hours: z.number().positive(), term: z.string() }).nullable(),
    topN: z.number().int().positive().nullable(),
  }),
});

export function turnContextOf(c: Classification): TurnContext {
  return { intent: c.intent, entities: c.entities };
}

/** Reads a persisted context back; null when it does not parse (an older build wrote it) so the turn stands alone. */
export function parseTurnContext(value: unknown): TurnContext | null {
  const parsed = turnContextSchema.safeParse(value);
  if (!parsed.success) return null;
  const e = parsed.data.entities;
  const period =
    e.period === null
      ? null
      : (Object.values(PERIODS).find(
          (p) => p.granularity === e.period?.granularity && p.back === e.period.back,
        ) ?? { ...e.period });
  return {
    intent: parsed.data.intent,
    entities: {
      ...e,
      attribute: e.attribute as Entities['attribute'],
      measurement: e.measurement as MeasurementName | null,
      groupBy:
        e.groupBy === null
          ? null
          : e.groupBy.kind === 'attribute'
            ? { kind: 'attribute', family: e.groupBy.family as NonNullable<Entities['attribute']> }
            : e.groupBy,
      period,
    },
  };
}

/** Intents that come from an explicit marker word rather than from the entities. */
const MARKER_INTENTS: ReadonlySet<AssistantIntent> = new Set([
  'howto',
  'report',
  'impact',
  'incidents',
  'anomalies',
  'availability',
  'history',
]);

function wordCount(normalised: string): number {
  return normalised.split(' ').filter((w) => w.length > 0).length;
}

/**
 * Whether a question leans on the previous turn: it opens with a continuation word, or it is short, carries no
 * intent marker of its own and names only a fragment (a type, a period, a window, a scope word, a grouping).
 */
export function isFollowUp(c: Classification): boolean {
  if (startsWithContinuation(c.normalised)) return true;
  if (intentMarker(c.normalised) !== null) return false;
  if (wordCount(c.normalised) > ASSISTANT.followUpMaxWords) return false;
  if (c.intent !== 'unknown' && c.intent !== 'lookup') return false;
  const e = c.entities;
  if (e.names.length > 0) return false;
  return (
    e.types.length > 0 ||
    e.period !== null ||
    e.range !== null ||
    e.filters.length > 0 ||
    e.groupBy !== null ||
    e.aggregate !== null
  );
}

/** The measurement of the same family for another subject type: "and for VMs?" after a host CPU question. */
export function measurementFor(previous: MeasurementName, type: CiType): MeasurementName | null {
  const previousTerms = new Set([...MEASUREMENTS[previous].terms.en, ...MEASUREMENTS[previous].terms.ar]);
  let best: { name: MeasurementName; shared: number } | null = null;
  for (const name of Object.keys(MEASUREMENTS) as MeasurementName[]) {
    const m = MEASUREMENTS[name];
    if (!(m.subjects as readonly CiType[]).includes(type)) continue;
    const shared = [...m.terms.en, ...m.terms.ar].filter((term) => previousTerms.has(term)).length;
    if (shared > 0 && (best === null || shared > best.shared)) best = { name, shared };
  }
  return best?.name ?? null;
}

/** Whether a marker intent still makes sense for the merged entities (availability needs services, impact a name). */
function markerFits(intent: AssistantIntent, e: Entities): boolean {
  switch (intent) {
    case 'availability':
    case 'incidents':
      return e.types.length === 0 || e.types.includes('business_service');
    case 'impact':
    case 'history':
      return e.names.length > 0;
    default:
      return true;
  }
}

/**
 * Fills what the question left out from the previous turn and derives the intent again. A question that stands on
 * its own, or a turn with nothing before it, comes back unchanged; what was inherited is recorded in `matched` as
 * `followup:<field>` so the evidence shows the reading.
 */
export function resolveFollowUp(c: Classification, previous: TurnContext | null): Classification {
  if (previous === null || previous.intent === 'unknown' || !isFollowUp(c)) return c;
  const cur = c.entities;
  const prev = previous.entities;
  const inherited: string[] = [];
  const take = <K extends keyof Entities>(key: K, own: boolean): Entities[K] => {
    if (own) return cur[key];
    inherited.push('followup:' + key);
    return prev[key];
  };
  const typesSwapped = cur.types.length > 0 && cur.types[0] !== prev.types[0];
  const types = take('types', cur.types.length > 0);
  // A new subject is a new population: the previous names and scope do not carry over to it.
  const names = typesSwapped ? cur.names : take('names', cur.names.length > 0);
  const filters = typesSwapped ? cur.filters : take('filters', cur.filters.length > 0);
  let measurement = take('measurement', cur.measurement !== null);
  if (typesSwapped && cur.measurement === null && prev.measurement !== null && types[0] !== undefined)
    measurement = measurementFor(prev.measurement, types[0]) ?? prev.measurement;
  // A period and a window are the same slot: the one the question names replaces whichever the last turn had.
  const timed = cur.period !== null || cur.range !== null;
  const period = timed ? cur.period : take('period', false);
  const range = timed ? cur.range : take('range', false);
  const merged: Entities = {
    types,
    attribute: take('attribute', cur.attribute !== null),
    measurement,
    aggregate: take('aggregate', cur.aggregate !== null),
    groupBy: take('groupBy', cur.groupBy !== null),
    names,
    filters,
    health: take('health', cur.health !== null),
    period,
    range,
    topN: take('topN', cur.topN !== null),
  };
  const ownMarker = intentMarker(c.normalised)?.intent ?? null;
  const previousMarker =
    MARKER_INTENTS.has(previous.intent) && markerFits(previous.intent, merged) ? previous.intent : null;
  const derived = deriveIntent(merged, ownMarker ?? previousMarker);
  if (ownMarker === null && previousMarker !== null) inherited.push('followup:intent');
  return {
    intent: derived.intent,
    confidence: Math.max(derived.confidence, ASSISTANT.followUpConfidence),
    locale: c.locale,
    entities: merged,
    matched: [...c.matched, ...inherited],
    normalised: c.normalised,
  };
}
