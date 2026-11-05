// REQ-AI-008 (ADR-028) — conversation persistence: `assistant_conversations` and `assistant_turns`. Every read is
// scoped to the tenant and the user who asked; the answer JSON is checked against the contract on the way in and
// on the way out, so a row an older build wrote never reaches the console unparsed.
import { Injectable } from '@nestjs/common';
import { ASSISTANT, type Locale } from '@openmap/constants';
import {
  assistantTurnAnswerSchema,
  type AssistantTurnAnswer,
  type AssistantTurnOutcome,
} from '@openmap/contracts';
import type { Prisma, PrismaClient } from '@openmap/db';
import { isoOf } from '../common/time.js';
import { PrismaService } from '../db/prisma.service.js';

export const CONVERSATIONS_REPOSITORY = Symbol('CONVERSATIONS_REPOSITORY');

export interface ConversationRow {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
}

export interface TurnRow {
  id: string;
  conversationId: string;
  at: string;
  outcome: AssistantTurnOutcome;
  locale: Locale;
  question: string;
  answer: AssistantTurnAnswer;
}

export interface NewTurn {
  outcome: AssistantTurnOutcome;
  locale: Locale;
  question: string;
  answer: AssistantTurnAnswer;
}

export interface ConversationsRepository {
  /** The user's conversations, most recently updated first. */
  list(tenantId: string, userId: string): Promise<ConversationRow[]>;
  byId(tenantId: string, userId: string, id: string): Promise<ConversationRow | null>;
  turns(tenantId: string, userId: string, conversationId: string): Promise<TurnRow[]>;
  /** The newest turn of a conversation, for the follow-up resolution of the next question. */
  lastTurn(tenantId: string, userId: string, conversationId: string): Promise<TurnRow | null>;
  /** Appends a turn, creating the conversation first when `conversationId` is null; returns both ids. */
  append(
    tenantId: string,
    userId: string,
    conversationId: string | null,
    turn: NewTurn,
  ): Promise<{ conversationId: string; turnId: string }>;
  remove(tenantId: string, userId: string, id: string): Promise<boolean>;
}

type Row = Awaited<ReturnType<PrismaClient['assistantTurn']['findFirstOrThrow']>>;

function toTurn(row: Row): TurnRow | null {
  const answer = assistantTurnAnswerSchema.safeParse(row.answer);
  if (!answer.success) return null;
  return {
    id: row.id,
    conversationId: row.conversationId,
    at: isoOf(row.at),
    outcome: row.outcome,
    locale: row.locale,
    question: row.question,
    answer: answer.data,
  };
}

/** The first question, clipped, is the title a conversation is listed under. */
export function titleOf(question: string): string {
  const trimmed = question.trim().replace(/\s+/g, ' ');
  return trimmed.length > ASSISTANT.conversationTitleLength
    ? trimmed.slice(0, ASSISTANT.conversationTitleLength - 1).trimEnd() + '…'
    : trimmed;
}

@Injectable()
export class PrismaConversationsRepository implements ConversationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, userId: string): Promise<ConversationRow[]> {
    const rows = await this.prisma.client.assistantConversation.findMany({
      where: { tenantId, userId },
      orderBy: { updatedAt: 'desc' },
      take: ASSISTANT.conversationListLimit,
      include: { _count: { select: { turns: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: isoOf(r.createdAt),
      updatedAt: isoOf(r.updatedAt),
      turnCount: r._count.turns,
    }));
  }

  async byId(tenantId: string, userId: string, id: string): Promise<ConversationRow | null> {
    const r = await this.prisma.client.assistantConversation.findFirst({
      where: { id, tenantId, userId },
      include: { _count: { select: { turns: true } } },
    });
    return r === null
      ? null
      : {
          id: r.id,
          title: r.title,
          createdAt: isoOf(r.createdAt),
          updatedAt: isoOf(r.updatedAt),
          turnCount: r._count.turns,
        };
  }

  async turns(tenantId: string, userId: string, conversationId: string): Promise<TurnRow[]> {
    const rows = await this.prisma.client.assistantTurn.findMany({
      where: { tenantId, conversationId, conversation: { userId } },
      orderBy: { at: 'asc' },
    });
    return rows.map(toTurn).filter((t): t is TurnRow => t !== null);
  }

  async lastTurn(tenantId: string, userId: string, conversationId: string): Promise<TurnRow | null> {
    const row = await this.prisma.client.assistantTurn.findFirst({
      where: { tenantId, conversationId, conversation: { userId } },
      orderBy: { at: 'desc' },
    });
    return row === null ? null : toTurn(row);
  }

  async append(
    tenantId: string,
    userId: string,
    conversationId: string | null,
    turn: NewTurn,
  ): Promise<{ conversationId: string; turnId: string }> {
    const answer = assistantTurnAnswerSchema.parse(turn.answer) as unknown as Prisma.InputJsonValue;
    return this.prisma.client.$transaction(async (tx) => {
      const conversation =
        conversationId === null
          ? await tx.assistantConversation.create({
              data: { tenantId, userId, title: titleOf(turn.question) },
              select: { id: true },
            })
          : await tx.assistantConversation.update({
              where: { id: conversationId },
              // Touching updatedAt keeps the list ordered by last activity.
              data: { updatedAt: new Date() },
              select: { id: true },
            });
      const created = await tx.assistantTurn.create({
        data: {
          tenantId,
          conversationId: conversation.id,
          outcome: turn.outcome,
          locale: turn.locale,
          question: turn.question,
          answer,
        },
        select: { id: true },
      });
      return { conversationId: conversation.id, turnId: created.id };
    });
  }

  async remove(tenantId: string, userId: string, id: string): Promise<boolean> {
    const deleted = await this.prisma.client.assistantConversation.deleteMany({ where: { id, tenantId, userId } });
    return deleted.count > 0;
  }
}
