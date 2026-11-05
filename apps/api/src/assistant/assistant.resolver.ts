// REQ-AI-001 REQ-AI-007 — Mutation.askAssistant(question, locale).
import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { z } from 'zod';
import { ASSISTANT, LOCALES } from '@openmap/constants';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { AssistantService } from './assistant.service.js';
import type { AssistantAnswerView } from './assistant.types.js';

const questionArg = z.string().trim().min(1).max(ASSISTANT.maxQuestionLength);
const localeArg = z.enum(LOCALES).nullable().optional();

@Resolver()
export class AssistantResolver {
  constructor(
    private readonly service: AssistantService,
    private readonly tenant: TenantContext,
  ) {}

  @Mutation('askAssistant')
  @Roles(ROLES.analyst)
  askAssistant(
    @Args('question') question: unknown,
    @Args('locale') locale: unknown,
  ): Promise<AssistantAnswerView> {
    return this.service.ask(
      this.tenant.tenantId,
      this.tenant.username,
      parseInput(questionArg, question, 'question'),
      parseInput(localeArg, locale, 'locale') ?? null,
    );
  }
}
