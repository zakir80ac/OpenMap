// REQ-AI-007 (ADR-028) — what every skill receives and returns. A skill runs one plan step against a store and
// hands back the structured result (query, parameters, rows, duration, typed summary) or a clarification when a
// name in the question is ambiguous or unknown; it never words the answer and never throws for an empty estate.
import { ASSISTANT, type Locale } from '@openmap/constants';
import type { Clarification, SkillResult, Summary } from '@openmap/assistant';
import type { AssistantStore, CiType } from '@openmap/contracts';
import type { CiRecord } from '../../ci/ci.types.js';
import type { NameResolution } from '../entity.resolver.js';

export interface SkillContext {
  tenantId: string;
  locale: Locale;
  question: string;
  /** CI types the question named; an ambiguous name is narrowed to them before the person is asked. */
  types: readonly CiType[];
}

export interface SkillOutcome {
  results: SkillResult[];
  clarification: Clarification | null;
}

export function startTimer(): () => number {
  const started = Date.now();
  return () => Date.now() - started;
}

export function clip(query: string): string {
  return query.length > ASSISTANT.evidenceQueryMaxLength
    ? query.slice(0, ASSISTANT.evidenceQueryMaxLength)
    : query;
}

/** Positional SQL parameters as a record for the evidence. */
export function paramsOf(values: readonly unknown[]): Record<string, unknown> {
  return Object.fromEntries(values.map((v, i) => ['$' + String(i + 1), v]));
}

export function result(
  step: SkillResult['step'],
  store: AssistantStore,
  query: string,
  params: Record<string, unknown>,
  rows: Array<Record<string, unknown>>,
  durationMs: number,
  summary: Summary | null,
  ciIds: string[] = [],
): SkillResult {
  return { step, store, query: clip(query), params, rows, durationMs, error: null, summary, ciIds };
}

export function failed(
  step: SkillResult['step'],
  store: AssistantStore,
  query: string,
  params: Record<string, unknown>,
  durationMs: number,
  error: string,
): SkillResult {
  return { step, store, query: clip(query), params, rows: [], durationMs, error, summary: null, ciIds: [] };
}

/** The clarification for a name that is ambiguous or unknown; the options re-ask the question with the exact code. */
export function nameClarification(resolution: NameResolution, question: string): Clarification {
  const candidates = resolution.exact.length > 0 ? resolution.exact : resolution.close;
  const options = candidates
    .slice(0, ASSISTANT.clarificationChoices)
    .map((ci: CiRecord) => ({
      label: ci.displayName + ' (' + ci.code + ')',
      value: question.replace(resolution.name, ci.code),
    }));
  return resolution.exact.length > 1
    ? { key: 'assistant.clarify.which', params: { name: resolution.name }, options }
    : { key: 'assistant.clarify.noMatch', params: { name: resolution.name }, options };
}

/** The one CI a name settles on, or null when the person has to choose. */
export function settled(resolution: NameResolution): CiRecord | null {
  return resolution.exact.length === 1 ? (resolution.exact[0] ?? null) : null;
}
