// REQ-AI-001 — question → validated read-only Cypher → rows → answer. The generated Cypher is always
// shown to the user and validated before it reaches the engine; writes are impossible by construction.
import { ASSISTANT } from '@openmap/constants';
import { assertReadOnly, type GraphRepository } from '@openmap/graph';
import type { ChatMessage, LlmClient } from './llm.js';
import { systemPrompt } from './grounding.js';

export interface AssistantAnswer {
  question: string;
  cypher: string;
  rows: Array<Record<string, unknown>>;
  text: string;
  truncated: boolean;
}

export class AssistantError extends Error {
  constructor(message: string, public readonly cypher: string | null) {
    super(message);
    this.name = 'AssistantError';
  }
}

/** Strips code fences and trailing prose the model may add despite instructions. */
export function extractCypher(text: string): string {
  const fenced = /```(?:cypher)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced ? fenced[1] : text) ?? '';
  const firstKeyword = body.search(/\b(MATCH|OPTIONAL MATCH|WITH|UNWIND|RETURN|CALL)\b/i);
  const cut = firstKeyword >= 0 ? body.slice(firstKeyword) : body;
  return cut.trim().replace(/;\s*$/, '');
}

export function validateCypher(cypher: string): void {
  if (cypher.length === 0) throw new AssistantError('the model returned no query', null);
  if (cypher.length > ASSISTANT.maxCypherLength) throw new AssistantError('generated query is too long', cypher);
  assertReadOnly(cypher);
  if (!/\$tenantId/.test(cypher)) throw new AssistantError('generated query does not scope by tenant', cypher);
  if (!/\bRETURN\b/i.test(cypher)) throw new AssistantError('generated query returns nothing', cypher);
  // Only the parameters the engine is given may appear; an invented one would fail at run time with a worse message.
  const unknown = [...cypher.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1] ?? '').filter((name) => !ALLOWED_PARAMETERS.has(name));
  if (unknown.length > 0) throw new AssistantError('generated query uses unknown parameter $' + String(unknown[0]) + '; only $tenantId and $now exist, write literal values inline', cypher);
}

/** Parameters `ask` passes to the engine; the grounding prompt names exactly these. */
export const ALLOWED_PARAMETERS: ReadonlySet<string> = new Set(['tenantId', 'now']);

/** Adds a LIMIT when the model forgot one, so a broad question cannot flood the console. */
export function enforceLimit(cypher: string): string {
  if (/\bLIMIT\s+\d+\s*$/i.test(cypher) || /\bcount\s*\(/i.test(cypher)) return cypher;
  return cypher + '\nLIMIT ' + String(ASSISTANT.maxRowsReturned);
}

function summarise(question: string, rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return 'No matching items were found for: ' + question;
  const first = rows[0] ?? {};
  const columns = Object.keys(first);
  const names = rows.map((r) => r['name'] ?? r['s.name'] ?? r['c.name']).filter((v): v is string => typeof v === 'string');
  const shown = names.slice(0, ASSISTANT.summaryNames);
  const more = names.length - shown.length;
  if (names.length > 0) return String(rows.length) + ' result' + (rows.length === 1 ? '' : 's') + ': ' + shown.join(', ') + (more > 0 ? ' and ' + String(more) + ' more' : '') + '.';
  return String(rows.length) + ' row' + (rows.length === 1 ? '' : 's') + ' with columns ' + columns.join(', ') + '.';
}

const REPAIR_RULES = 'Rewrite it following the rules (read-only, every node variable filtered by tenantId = $tenantId, no parameters other than $tenantId and $now, aggregations only in WITH or RETURN, a RETURN clause). Reply with only the Cypher query.';

/**
 * Asks the model for a query, validates it and runs it. When the validator or the graph engine rejects the query,
 * the rejection goes back to the model as the next turn so it can repair its own output (missing $tenantId scope,
 * an invented parameter, a write, a misplaced aggregation); small models need this, large ones rarely use it. The
 * last rejection is what the user sees when every attempt fails.
 */
export async function ask(question: string, tenantId: string, llm: LlmClient, repo: GraphRepository, now: () => string = () => new Date().toISOString()): Promise<AssistantAnswer> {
  if (question.trim().length === 0 || question.length > ASSISTANT.maxQuestionLength) throw new AssistantError('question is empty or too long', null);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: question },
  ];
  let lastError: AssistantError | null = null;
  for (let attempt = 0; attempt <= ASSISTANT.repairAttempts; attempt++) {
    const completion = await llm.complete(messages);
    const cypher = enforceLimit(extractCypher(completion.text));
    try {
      validateCypher(cypher);
      const rows = await repo.readOnly<Record<string, unknown>>(cypher, { tenantId, now: now() });
      const truncated = rows.length >= ASSISTANT.maxRowsReturned;
      return { question, cypher, rows, text: summarise(question, rows), truncated };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = err instanceof AssistantError ? err : new AssistantError('the query failed to run: ' + message, cypher);
      messages.push({ role: 'assistant', content: completion.text });
      messages.push({ role: 'user', content: 'That query was rejected: ' + message + '. ' + REPAIR_RULES });
    }
  }
  throw lastError ?? new AssistantError('the model returned no query', null);
}
