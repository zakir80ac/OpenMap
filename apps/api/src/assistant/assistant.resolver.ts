// REQ-AI-001 — Mutation.askAssistant.
import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { z } from 'zod';
import { ASSISTANT } from '@openmap/constants';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { AssistantService, type AssistantAnswerView } from './assistant.service.js';

const questionArg = z.string().trim().min(1).max(ASSISTANT.maxQuestionLength);

@Resolver()
export class AssistantResolver {
  constructor(
    private readonly service: AssistantService,
    private readonly tenant: TenantContext,
  ) {}

  @Mutation('askAssistant')
  @Roles(ROLES.analyst)
  askAssistant(@Args('question') question: unknown): Promise<AssistantAnswerView> {
    return this.service.ask(this.tenant.tenantId, this.tenant.username, parseInput(questionArg, question, 'question'));
  }
}
