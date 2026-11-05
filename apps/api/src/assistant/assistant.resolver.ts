// REQ-AI-001 REQ-AI-007 REQ-AI-008 — Mutation.askAssistant(question, locale, conversationId), the conversation
// queries (`conversations`, `conversation`) and `deleteConversation`. A conversation belongs to the user who asked.
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { z } from 'zod';
import { ASSISTANT, LOCALES } from '@openmap/constants';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { AssistantService } from './assistant.service.js';
import type { AssistantAnswerView, ConversationView, TurnView } from './assistant.types.js';
import { ConversationsService } from './conversations.service.js';

const questionArg = z.string().trim().min(1).max(ASSISTANT.maxQuestionLength);
const localeArg = z.enum(LOCALES).nullable().optional();
const idArg = z.uuid();
const optionalIdArg = z.uuid().nullable().optional();

@Resolver()
export class AssistantResolver {
  constructor(
    private readonly service: AssistantService,
    private readonly conversations: ConversationsService,
    private readonly tenant: TenantContext,
  ) {}

  @Mutation('askAssistant')
  @Roles(ROLES.analyst)
  askAssistant(
    @Args('question') question: unknown,
    @Args('locale') locale: unknown,
    @Args('conversationId') conversationId: unknown,
  ): Promise<AssistantAnswerView> {
    return this.service.ask(
      this.tenant.tenantId,
      this.tenant.username,
      parseInput(questionArg, question, 'question'),
      parseInput(localeArg, locale, 'locale') ?? null,
      parseInput(optionalIdArg, conversationId, 'conversationId') ?? null,
    );
  }

  @Query('conversations')
  @Roles(ROLES.analyst)
  listConversations(): Promise<ConversationView[]> {
    return this.conversations.list(this.tenant.tenantId, this.tenant.username);
  }

  @Query('conversation')
  @Roles(ROLES.analyst)
  conversation(@Args('id') id: unknown): Promise<ConversationView | null> {
    return this.conversations.get(this.tenant.tenantId, this.tenant.username, parseInput(idArg, id, 'conversation id'));
  }

  @Mutation('deleteConversation')
  @Roles(ROLES.analyst)
  deleteConversation(@Args('id') id: unknown): Promise<boolean> {
    return this.conversations.remove(this.tenant.tenantId, this.tenant.username, parseInput(idArg, id, 'conversation id'));
  }
}

/** The turns of a conversation are loaded only when asked for: the list shows titles and counts. */
@Resolver('Conversation')
export class ConversationResolver {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('turns')
  turns(@Parent() conversation: ConversationView): Promise<TurnView[]> {
    return this.conversations.turns(this.tenant.tenantId, this.tenant.username, conversation.id);
  }
}
