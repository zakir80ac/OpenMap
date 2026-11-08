// REQ-AI-007 (ADR-028) — the model as a fallback classifier. When the vocabulary leaves a question unknown or the
// confidence low, the model is asked for a JSON verdict (intent, type, measurement, aggregate, name) and the reply
// is parsed strictly; a reply that is not valid JSON of this shape counts as no opinion. The model never sees the
// stores and never writes a query here; its verdict only picks which deterministic skill runs.
import { ASSISTANT } from '@openmap/constants';
import { ASSISTANT_AGGREGATES, ASSISTANT_INTENTS, CI_TYPES, type CiType } from '@openmap/contracts';
import { z } from 'zod';
import type { Classification } from './intent.js';
import type { ChatMessage } from './llm.js';
import {
  ATTRIBUTE_FAMILY_IDS,
  MEASUREMENT_NAMES,
  type AttributeFamilyId,
  type MeasurementName,
} from './vocabulary.js';

const verdictSchema = z.object({
  intent: z.enum(ASSISTANT_INTENTS),
  confidence: z.number().min(0).max(1),
  type: z.string().nullable().optional(),
  attribute: z.string().nullable().optional(),
  measurement: z.string().nullable().optional(),
  aggregate: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
});
export type IntentVerdict = z.infer<typeof verdictSchema>;

export function intentMessages(question: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        'Classify a question about an IT estate. Reply with one JSON object and nothing else.',
        'Fields: intent (one of ' +
          ASSISTANT_INTENTS.join(', ') +
          '), confidence (0 to 1), type (one of ' +
          CI_TYPES.join(', ') +
          ' or null), attribute (one of ' +
          ATTRIBUTE_FAMILY_IDS.join(', ') +
          ' or null), measurement (one of ' +
          MEASUREMENT_NAMES.join(', ') +
          ' or null), aggregate (one of ' +
          ASSISTANT_AGGREGATES.join(', ') +
          ' or null), name (a CI name quoted in the question or null).',
        'count: how many of a type. attribute_stats: a figure or breakdown over an attribute such as memory, cores, OS, model. measurement: utilisation, throughput, power, IOPS from monitoring. availability: uptime, SLA, downtime. incidents: incidents or outages. anomalies: anomalies the rules found, such as IP conflicts, unmanaged devices in a data centre, flapping services. impact: what depends on something or is affected by its failure. history: what changed and when. howto: how to use OpenMap. lookup: list or find items. unknown: none of these.',
      ].join('\n'),
    },
    { role: 'user', content: question },
  ];
}

function pick<T extends string>(value: string | null | undefined, allowed: readonly T[]): T | null {
  return value !== null && value !== undefined && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** The verdict, or null when the reply is not the JSON asked for. */
export function parseVerdict(text: string): IntentVerdict | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    const result = verdictSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Merges the model's verdict into the deterministic classification: it fills gaps, never overrides a confident match. */
export function applyVerdict(c: Classification, verdict: IntentVerdict): Classification {
  const confidence = Math.min(
    verdict.confidence,
    ASSISTANT.minIntentConfidence + (1 - ASSISTANT.minIntentConfidence) * verdict.confidence,
  );
  if (c.intent !== 'unknown' && c.confidence >= ASSISTANT.minIntentConfidence) return c;
  const type = pick<CiType>(verdict.type, CI_TYPES);
  const attribute = pick<AttributeFamilyId>(verdict.attribute, ATTRIBUTE_FAMILY_IDS);
  const measurement = pick<MeasurementName>(verdict.measurement, MEASUREMENT_NAMES);
  const aggregate = pick(verdict.aggregate, ASSISTANT_AGGREGATES);
  const names =
    verdict.name !== null &&
    verdict.name !== undefined &&
    verdict.name.trim().length > 0 &&
    !c.entities.names.includes(verdict.name)
      ? [...c.entities.names, verdict.name.trim()]
      : c.entities.names;
  return {
    ...c,
    intent: verdict.intent,
    confidence,
    matched: [...c.matched, 'llm:' + verdict.intent],
    entities: {
      ...c.entities,
      types:
        type !== null && !c.entities.types.includes(type) ? [...c.entities.types, type] : c.entities.types,
      attribute: c.entities.attribute ?? attribute,
      measurement: c.entities.measurement ?? measurement,
      aggregate: c.entities.aggregate ?? aggregate,
      names,
    },
  };
}
