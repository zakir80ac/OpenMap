// REQ-AI-001 — askAssistant: question → validated read-only Cypher → rows → answer, through the
// assistant package against the tenant's graph. Gated by FEATURE_ASSISTANT and the tenant setting.
import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ask, AssistantError, createLlmClient, type LlmClient } from '@openmap/assistant';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord } from '../ci/ci.types.js';
import { isUuid } from '../common/uuid.js';
import { ENV, type Env } from '../config/env.module.js';
import { GraphService } from '../db/graph.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { TenantSettingsService } from '../tenant/tenant-settings.service.js';

export interface AssistantAnswerView {
  text: string;
  cypher: string;
  rows: Array<Record<string, unknown>>;
  cis: CiRecord[];
}

/** UUIDs appearing anywhere in the result rows; they are resolved to CIs for the console to link. */
export function ciIdsIn(rows: ReadonlyArray<Record<string, unknown>>): string[] {
  const ids = new Set<string>();
  const visit = (v: unknown): void => {
    if (isUuid(v)) ids.add(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v !== null && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(visit);
  };
  rows.forEach(visit);
  return [...ids];
}

@Injectable()
export class AssistantService {
  private readonly llm: LlmClient;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly graph: GraphService,
    private readonly settings: TenantSettingsService,
    private readonly outbox: OutboxService,
  ) {
    this.llm = createLlmClient(env);
  }

  async ask(tenantId: string, actor: string, question: string): Promise<AssistantAnswerView> {
    if (!this.env.FEATURE_ASSISTANT) throw new ForbiddenException('the assistant is disabled in this deployment (FEATURE_ASSISTANT)');
    if (!(await this.settings.get(tenantId)).assistantEnabled) throw new ForbiddenException('the assistant is disabled for this tenant');
    let answer;
    try {
      answer = await ask(question, tenantId, this.llm, this.graph.repo);
    } catch (err) {
      if (err instanceof AssistantError) throw new BadRequestException({ message: err.message, cypher: err.cypher });
      throw err;
    }
    const cis = await this.cis.findByIds(tenantId, ciIdsIn(answer.rows));
    await this.outbox.transaction(tenantId, async ({ emit }) => {
      await emit({ type: 'openmap.assistant.query.answered', subject: tenantId, data: { question, cypher: answer.cypher, rows: answer.rows.length, truncated: answer.truncated, by: actor } });
    });
    return { text: answer.text, cypher: answer.cypher, rows: answer.rows, cis };
  }
}
