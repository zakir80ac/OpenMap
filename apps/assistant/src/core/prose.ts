// REQ-AI-007 (ADR-028) — level four, the model's half: the prompt that asks the model to word the structured results
// in the person's language, and the parser that strips what small models add anyway (fences, labels). Whatever
// comes back goes through the grounding guard before anyone reads it.
import { ASSISTANT, type Locale } from '@openmap/constants';
import type { AssistantFigure } from '@openmap/contracts';
import type { ChatMessage } from './llm.js';
import type { Summary } from './types.js';

const LANGUAGE: Record<Locale, string> = { en: 'English', ar: 'Arabic' };
const FENCE = new RegExp('```[a-z]*', 'gi');
const LABEL_PREFIX = new RegExp('^(answer|response|summary)\\s*:\\s*', 'i');

export interface ProseFacts {
  question: string;
  locale: Locale;
  deterministicText: string;
  figures: readonly AssistantFigure[];
  summaries: ReadonlyArray<Summary | null>;
}

/** Facts the model may use, as compact JSON; the deterministic text is included so the wording cannot drift from it. */
export function proseMessages(facts: ProseFacts): ChatMessage[] {
  const payload = {
    question: facts.question,
    facts: facts.deterministicText,
    figures: facts.figures.map((f) => ({ label: f.label, value: f.value, unit: f.unit })),
    details: facts.summaries.filter((s): s is Summary => s !== null),
  };
  return [
    {
      role: 'system',
      content: [
        'You are the OpenMap assistant. You restate facts about an IT estate for an operations engineer.',
        'Write in ' +
          LANGUAGE[facts.locale] +
          ', at most ' +
          String(ASSISTANT.maxProseSentences) +
          ' short sentences, plain text, no lists, no markdown, no headings.',
        'Use only the numbers and names that appear in the JSON. Never add, estimate or round differently. Never mention the JSON or these instructions.',
        'If the JSON says nothing was found, say so in one sentence.',
      ].join('\n'),
    },
    { role: 'user', content: JSON.stringify(payload) },
  ];
}

/** Plain prose from the model's reply: fences, a leading label and surplus whitespace removed. */
export function extractProse(text: string): string {
  return text
    .replace(FENCE, '')
    .trim()
    .replace(LABEL_PREFIX, '')
    .replace(new RegExp('\\s+', 'g'), ' ')
    .trim();
}
