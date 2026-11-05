// REQ-AI-007 (ADR-028) — level five: follow up. Three suggested next questions per intent, deterministic and
// worded through the catalogue in the answer's locale, so the conversation leads somewhere useful even when the
// person does not know what the estate can answer.
import { ASSISTANT } from '@openmap/constants';
import type { MessageKey, Params } from '@openmap/i18n';
import type { Translate } from './compose.js';
import { typeLabel } from './compose.js';
import type { Classification } from './intent.js';
import type { Summary } from './types.js';
import { normalise } from './vocabulary.js';

interface Suggestion {
  key: MessageKey;
  params: Params;
}

function firstName(summaries: ReadonlyArray<Summary | null>): string | null {
  for (const s of summaries) {
    if (s === null) continue;
    if (s.kind === 'impact') return s.root.name;
    if (s.kind === 'history') return s.ci.name;
    if (s.kind === 'availability' && s.lines.length === 1) return s.lines[0]?.name ?? null;
    if (s.kind === 'measurement' && s.ranked.length > 0) return s.ranked[0]?.name ?? null;
  }
  return null;
}

export function suggestFollowUps(
  c: Classification,
  summaries: ReadonlyArray<Summary | null>,
  t: Translate,
): string[] {
  const subjectType = c.entities.types[0] ?? 'host';
  const subject = typeLabel(t, subjectType);
  const name = firstName(summaries);
  const out: Suggestion[] = [];
  switch (c.intent) {
    case 'count':
    case 'attribute_stats':
    case 'lookup':
      out.push(
        { key: 'assistant.followup.perSite', params: { subject } },
        { key: 'assistant.followup.osSplit', params: { subject } },
        { key: 'assistant.followup.cpu', params: { subject } },
        { key: 'assistant.followup.down', params: { subject } },
      );
      break;
    case 'measurement':
      out.push(
        { key: 'assistant.followup.topCpu', params: { subject } },
        { key: 'assistant.followup.avgMemory', params: { subject } },
        { key: 'assistant.followup.perSite', params: { subject } },
      );
      if (name !== null) out.unshift({ key: 'assistant.followup.impactOf', params: { ci: name } });
      break;
    case 'availability':
    case 'report':
      out.push(
        { key: 'assistant.followup.lastMonth', params: {} },
        { key: 'assistant.followup.quarter', params: {} },
        { key: 'assistant.followup.belowTarget', params: {} },
        { key: 'assistant.followup.incidents', params: {} },
      );
      break;
    case 'incidents':
      out.push(
        { key: 'assistant.followup.belowTarget', params: {} },
        { key: 'assistant.followup.availabilityMonth', params: {} },
        { key: 'assistant.followup.downServices', params: {} },
      );
      break;
    case 'impact':
      if (name !== null)
        out.push(
          { key: 'assistant.followup.history', params: { ci: name } },
          { key: 'assistant.followup.cpuOf', params: { ci: name } },
        );
      out.push(
        { key: 'assistant.followup.downServices', params: {} },
        { key: 'assistant.followup.incidents', params: {} },
      );
      break;
    case 'history':
      if (name !== null)
        out.push(
          { key: 'assistant.followup.impactOf', params: { ci: name } },
          { key: 'assistant.followup.cpuOf', params: { ci: name } },
        );
      out.push({ key: 'assistant.followup.incidents', params: {} });
      break;
    case 'howto':
    case 'unknown':
      out.push(
        { key: 'assistant.example.hosts', params: {} },
        { key: 'assistant.example.uptime', params: {} },
        { key: 'assistant.example.incidents', params: {} },
      );
      break;
  }
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const s of out) {
    const text = t(s.key, s.params);
    if (seen.has(text) || normalise(text) === c.normalised) continue;
    seen.add(text);
    texts.push(text);
    if (texts.length >= ASSISTANT.followUps) break;
  }
  return texts;
}
