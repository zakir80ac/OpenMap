// REQ-AI-007 (ADR-028) — the answer the API returns for `askAssistant`: the text, the graph query and rows of a
// `graph.query` step (empty otherwise), the CIs the answer names, the intent and confidence, the figures the prose
// rests on, every retrieval step as evidence, the follow-ups and, when the assistant has to ask back, the
// clarification with its choices.
import type {
  AssistantClarification,
  AssistantEvidence,
  AssistantFigure,
  AssistantIntent,
} from '@openmap/contracts';
import type { CiRecord } from '../ci/ci.types.js';

export interface AssistantAnswerView {
  text: string;
  cypher: string;
  rows: Array<Record<string, unknown>>;
  cis: CiRecord[];
  intent: AssistantIntent;
  confidence: number;
  figures: AssistantFigure[];
  evidence: AssistantEvidence[];
  followUps: string[];
  clarification: AssistantClarification | null;
  grounded: boolean;
}
