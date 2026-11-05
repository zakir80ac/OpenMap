// REQ-AI-007 REQ-AI-008 (ADR-028) — the assistant contract: the intents a question is classified into, the
// retrieval skills a plan is made of, the stores they read and the aggregate functions an attribute or
// measurement question may ask for. The GraphQL enums mirror these lists; the console labels them through i18n.
import { z } from 'zod';

/** What the person wants; `unknown` is answered with a clarifying question, never a guess. */
export const ASSISTANT_INTENTS = [
  'lookup',
  'count',
  'attribute_stats',
  'measurement',
  'availability',
  'incidents',
  'impact',
  'history',
  'howto',
  'report',
  'unknown',
] as const;
export type AssistantIntent = (typeof ASSISTANT_INTENTS)[number];
export const assistantIntentSchema = z.enum(ASSISTANT_INTENTS);

/** Named retrieval steps; every plan is a short list of these with validated parameters. */
export const ASSISTANT_SKILLS = [
  'graph.query',
  'cmdb.attributes',
  'metrics.latest',
  'services.availability',
  'incidents',
  'impact',
  'history',
  'howto',
] as const;
export type AssistantSkill = (typeof ASSISTANT_SKILLS)[number];
export const assistantSkillSchema = z.enum(ASSISTANT_SKILLS);

export const ASSISTANT_STORES = ['postgres', 'memgraph', 'clickhouse', 'catalogue'] as const;
export type AssistantStore = (typeof ASSISTANT_STORES)[number];

/** Aggregates over an attribute, a relationship fan-out or a measurement. */
export const ASSISTANT_AGGREGATES = ['count', 'avg', 'sum', 'min', 'max', 'distribution'] as const;
export type AssistantAggregate = (typeof ASSISTANT_AGGREGATES)[number];
export const assistantAggregateSchema = z.enum(ASSISTANT_AGGREGATES);

/** A figure the prose rests on; the grounding guard admits only numbers that appear here or in the rows. */
export const assistantFigureSchema = z.object({
  label: z.string().min(1),
  value: z.number(),
  unit: z.string(),
});
export type AssistantFigure = z.infer<typeof assistantFigureSchema>;

/** One executed retrieval step as the person can inspect it. */
export const assistantEvidenceSchema = z.object({
  skill: assistantSkillSchema,
  store: z.enum(ASSISTANT_STORES),
  query: z.string(),
  params: z.record(z.string(), z.unknown()),
  rows: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type AssistantEvidence = z.infer<typeof assistantEvidenceSchema>;

export const assistantOptionSchema = z.object({ label: z.string().min(1), value: z.string().min(1) });
export type AssistantOption = z.infer<typeof assistantOptionSchema>;

/** The question the assistant asks back when a name is ambiguous or the intent is unclear. */
export const assistantClarificationSchema = z.object({
  question: z.string().min(1),
  options: z.array(assistantOptionSchema),
});
export type AssistantClarification = z.infer<typeof assistantClarificationSchema>;
