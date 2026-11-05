// REQ-AI-008 (ADR-028) — conversation use cases: list and read the signed-in user's conversations, hand the last
// turn's reading to the next question, record every turn as it was answered, delete a conversation. The CIs an
// answer named are stored by id and resolved again when the thread is read, so a renamed or retired CI shows as it
// is now. Deletion is audited by the global interceptor like every mutation.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Locale } from '@openmap/constants';
import { parseTurnContext, type TurnContext } from '@openmap/assistant';
import type { AssistantTurnAnswer, AssistantTurnOutcome } from '@openmap/contracts';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord } from '../ci/ci.types.js';
import type { AssistantAnswerView, ConversationView, TurnView } from './assistant.types.js';
import {
  CONVERSATIONS_REPOSITORY,
  type ConversationsRepository,
  type TurnRow,
} from './conversations.repository.js';

@Injectable()
export class ConversationsService {
  constructor(
    @Inject(CONVERSATIONS_REPOSITORY) private readonly repo: ConversationsRepository,
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
  ) {}

  list(tenantId: string, user: string): Promise<ConversationView[]> {
    return this.repo.list(tenantId, user);
  }

  get(tenantId: string, user: string, id: string): Promise<ConversationView | null> {
    return this.repo.byId(tenantId, user, id);
  }

  /** The turns of a conversation with every cited CI resolved, oldest first. */
  async turns(tenantId: string, user: string, conversationId: string): Promise<TurnView[]> {
    const rows = await this.repo.turns(tenantId, user, conversationId);
    const ids = [...new Set(rows.flatMap((r) => r.answer.ciIds))];
    const cis = new Map((await this.cis.findByIds(tenantId, ids)).map((ci) => [ci.id, ci]));
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      question: row.question,
      locale: row.locale,
      answer: answerView(row, cis),
    }));
  }

  /** The reading of the newest turn, for the follow-up resolution; a conversation that is not the user's is not found. */
  async previousContext(tenantId: string, user: string, conversationId: string): Promise<TurnContext | null> {
    const conversation = await this.repo.byId(tenantId, user, conversationId);
    if (conversation === null) throw new NotFoundException('conversation ' + conversationId + ' not found');
    const last = await this.repo.lastTurn(tenantId, user, conversationId);
    return last === null ? null : parseTurnContext(last.answer.context);
  }

  /** Persists a turn and returns the conversation (created when none was given) and turn ids. */
  record(
    tenantId: string,
    user: string,
    conversationId: string | null,
    question: string,
    locale: Locale,
    outcome: AssistantTurnOutcome,
    answer: AssistantTurnAnswer,
  ): Promise<{ conversationId: string; turnId: string }> {
    return this.repo.append(tenantId, user, conversationId, { outcome, locale, question, answer });
  }

  async remove(tenantId: string, user: string, id: string): Promise<boolean> {
    const removed = await this.repo.remove(tenantId, user, id);
    if (!removed) throw new NotFoundException('conversation ' + id + ' not found');
    return true;
  }
}

function answerView(row: TurnRow, cis: ReadonlyMap<string, CiRecord>): AssistantAnswerView {
  const a = row.answer;
  return {
    text: a.text,
    cypher: a.cypher,
    rows: a.rows,
    cis: a.ciIds.map((id) => cis.get(id)).filter((ci): ci is CiRecord => ci !== undefined),
    intent: a.intent,
    confidence: a.confidence,
    figures: a.figures,
    evidence: a.evidence,
    followUps: a.followUps,
    clarification: a.clarification,
    grounded: a.grounded,
    conversationId: row.conversationId,
    turnId: row.id,
  };
}
