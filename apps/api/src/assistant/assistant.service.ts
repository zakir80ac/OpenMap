// REQ-AI-001 REQ-AI-007 REQ-AI-008 (ADR-028) — askAssistant: understand → plan → retrieve → compose → follow up. The
// question is classified deterministically (the model only breaks ties), read against the previous turn of its
// conversation when it is a follow-up, planned into skill steps over Postgres, Memgraph and ClickHouse, each step run
// with a timeout and kept as evidence, worded through the message catalogue in the person's locale and, when enabled,
// reworded by the model under the grounding guard. Every turn is persisted on its conversation (created when the
// question opens one). Gated by FEATURE_ASSISTANT and the tenant setting; every question is an outbox event and a
// Prometheus observation.
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ASSISTANT, TIME, type Locale } from '@openmap/constants';
import {
  applyVerdict,
  checkGrounding,
  classify,
  composeAll,
  createLlmClient,
  hasContent,
  extractProse,
  intentMessages,
  isSmallTalk,
  parseVerdict,
  plan,
  proseMessages,
  resolveFollowUp,
  suggestFollowUps,
  turnContextOf,
  type Clarification,
  type Classification,
  type LlmClient,
  type PlanStep,
  type SkillResult,
} from '@openmap/assistant';
import type {
  AssistantClarification,
  AssistantEvidence,
  AssistantIntent,
  AssistantTurnOutcome,
} from '@openmap/contracts';
import { createTranslator } from '@openmap/i18n';
import { withSpan } from '@openmap/telemetry';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import { ENV, type Env } from '../config/env.module.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { TenantSettingsService } from '../tenant/tenant-settings.service.js';
import type { AssistantAnswerView } from './assistant.types.js';
import { ConversationsService } from './conversations.service.js';
import { AttributesSkill } from './skills/attributes.skill.js';
import { ciIdsIn, GraphSkill } from './skills/graph.skill.js';
import { MetricsSkill } from './skills/metrics.skill.js';
import { ServicesSkill } from './skills/services.skill.js';
import type { SkillContext, SkillOutcome } from './skills/skill.js';

export { ciIdsIn };

type Outcome = AssistantTurnOutcome;

/** Where a turn is recorded: the conversation it continues (null opens a new one) and the locale it was asked in. */
interface Thread {
  conversationId: string | null;
  locale: Locale;
}

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(what + ' timed out after ' + String(ms) + ' ms'));
    }, ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class AssistantService {
  private readonly llm: LlmClient;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly settings: TenantSettingsService,
    private readonly outbox: OutboxService,
    private readonly metrics: MetricsService,
    private readonly attributes: AttributesSkill,
    private readonly measurements: MetricsSkill,
    private readonly services: ServicesSkill,
    private readonly graph: GraphSkill,
    private readonly conversations: ConversationsService,
  ) {
    this.llm = createLlmClient(env);
  }

  async ask(
    tenantId: string,
    actor: string,
    question: string,
    requestedLocale: Locale | null,
    conversationId: string | null = null,
  ): Promise<AssistantAnswerView> {
    if (!this.env.FEATURE_ASSISTANT)
      throw new ForbiddenException('the assistant is disabled in this deployment (FEATURE_ASSISTANT)');
    const settings = await this.settings.get(tenantId);
    if (!settings.assistantEnabled) throw new ForbiddenException('the assistant is disabled for this tenant');
    const locale = requestedLocale ?? settings.locale;
    const t = createTranslator(locale);
    const started = Date.now();
    const thread: Thread = { conversationId, locale };

    let c = classify(question);
    // REQ-AI-008: "and last month?" is read against what the conversation's previous turn resolved to.
    if (conversationId !== null) {
      const previous = await this.conversations.previousContext(tenantId, actor, conversationId);
      c = resolveFollowUp(c, previous);
    }
    if (isSmallTalk(c.normalised)) {
      const answer = this.answer(
        c,
        t('assistant.answer.smallTalk'),
        [],
        suggestFollowUps(c, [], t),
        null,
        true,
        [],
      );
      return this.finish(tenantId, actor, question, c, answer, started, 'answered', thread);
    }
    if (c.intent === 'unknown' || c.confidence < ASSISTANT.minIntentConfidence)
      c = await this.consultModel(c, question);

    const context: SkillContext = { tenantId, locale, question, types: c.entities.types };
    const p = plan(c, question);
    if (p.clarification !== null) {
      const answer = this.answer(
        c,
        t(p.clarification.key, p.clarification.params),
        [],
        suggestFollowUps(c, [], t),
        this.renderClarification(p.clarification, t),
        true,
        [],
      );
      return this.finish(tenantId, actor, question, c, answer, started, 'clarified', thread);
    }

    const results: SkillResult[] = [];
    for (const step of p.steps) {
      const outcome = await this.runStep(step, context);
      if (outcome.clarification !== null) {
        const answer = this.answer(
          c,
          t(outcome.clarification.key, outcome.clarification.params),
          results,
          suggestFollowUps(c, [], t),
          this.renderClarification(outcome.clarification, t),
          true,
          [],
        );
        return this.finish(tenantId, actor, question, c, answer, started, 'clarified', thread);
      }
      results.push(...outcome.results);
    }

    const summaries = results.map((r) => r.summary);
    const composed = composeAll(results, t, locale);
    const cis = await this.cis.findByIds(tenantId, [
      ...new Set([...results.flatMap((r) => r.ciIds), ...ciIdsIn(results.flatMap((r) => r.rows))]),
    ]);
    let text = composed.text;
    let grounded = true;
    // The model rewords only answers with content, and only in the locales the deployment trusts it with: the CPU
    // profile's small model writes English well and Arabic poorly, so ASSISTANT_PROSE_LOCALES keeps Arabic deterministic.
    const proseLocales = this.env.ASSISTANT_PROSE_LOCALES.split(',').map((l) => l.trim());
    if (
      this.env.ASSISTANT_PROSE &&
      proseLocales.includes(locale) &&
      results.some((r) => r.summary !== null && hasContent(r.summary))
    ) {
      const prose = await this.wordWithModel(
        question,
        locale,
        composed.text,
        composed.figures,
        summaries,
        results,
        cis.map((ci) => ci.displayName),
      );
      if (prose !== null) text = prose;
      else grounded = false;
    }
    const followUps = suggestFollowUps(c, summaries, t);
    const answer = this.answer(c, text, results, followUps, null, grounded, cis);
    answer.figures = composed.figures;
    const allFailed = results.length > 0 && results.every((r) => r.error !== null);
    return this.finish(tenantId, actor, question, c, answer, started, allFailed ? 'failed' : 'answered', thread);
  }

  private async consultModel(c: Classification, question: string): Promise<Classification> {
    try {
      const reply = await withTimeout(
        this.llm.complete(intentMessages(question)),
        this.env.LLM_TIMEOUT_MS,
        'intent classification',
      );
      const verdict = parseVerdict(reply.text);
      return verdict === null ? c : applyVerdict(c, verdict);
    } catch {
      // The model is optional here: without its opinion the deterministic reading stands and the person is asked.
      return c;
    }
  }

  private runStep(step: PlanStep, context: SkillContext): Promise<SkillOutcome> {
    const run = (): Promise<SkillOutcome> => {
      switch (step.skill) {
        case 'cmdb.attributes':
          return this.attributes.run(step, context);
        case 'metrics.latest':
          return this.measurements.run(step, context);
        case 'metrics.series':
          return this.measurements.series(step, context);
        case 'services.availability':
          return this.services.availability(step, context);
        case 'incidents':
          return this.services.incidents(step, context);
        case 'impact':
          return this.graph.impact(step, context);
        case 'history':
          return this.graph.history(step, context);
        case 'graph.query':
          return this.graph.query(step, context, this.llm);
        case 'howto':
          return Promise.resolve({
            results: [
              {
                step,
                store: 'catalogue',
                query: 'howto(' + step.topic + ')',
                params: { topic: step.topic },
                rows: [],
                durationMs: 0,
                error: null,
                summary: { kind: 'howto', topic: step.topic },
                ciIds: [],
              },
            ],
            clarification: null,
          });
      }
    };
    const timeout =
      step.skill === 'graph.query'
        ? this.env.LLM_TIMEOUT_MS + ASSISTANT.skillTimeoutMs
        : ASSISTANT.skillTimeoutMs;
    return withSpan(TRACER_NAME, 'assistant.' + step.skill, { 'openmap.assistant.skill': step.skill }, () =>
      withTimeout(run(), timeout, step.skill).catch((err: unknown) => ({
        results: [
          {
            step,
            store: 'catalogue' as const,
            query: step.skill,
            params: {},
            rows: [],
            durationMs: timeout,
            error: err instanceof Error ? err.message : String(err),
            summary: null,
            ciIds: [],
          },
        ],
        clarification: null,
      })),
    );
  }

  private async wordWithModel(
    question: string,
    locale: Locale,
    deterministicText: string,
    figures: AssistantAnswerView['figures'],
    summaries: SkillResult['summary'][],
    results: SkillResult[],
    names: string[],
  ): Promise<string | null> {
    try {
      const reply = await withTimeout(
        this.llm.complete(proseMessages({ question, locale, deterministicText, figures, summaries })),
        this.env.LLM_TIMEOUT_MS,
        'prose',
      );
      const prose = extractProse(reply.text);
      const verdict = checkGrounding(prose, {
        figures,
        rows: results.flatMap((r) => r.rows),
        names: [...names, ...figures.map((f) => f.label)],
        question,
      });
      return verdict.ok ? prose : null;
    } catch {
      return null;
    }
  }

  private renderClarification(
    c: Clarification,
    t: ReturnType<typeof createTranslator>,
  ): AssistantClarification {
    return {
      question: t(c.key, c.params),
      options: c.options.map((o) => ('key' in o ? { label: t(o.key), value: t(o.key) } : o)),
    };
  }

  private answer(
    c: Classification,
    text: string,
    results: SkillResult[],
    followUps: string[],
    clarification: AssistantClarification | null,
    grounded: boolean,
    cis: AssistantAnswerView['cis'],
  ): AssistantAnswerView {
    const graphStep = results.find((r) => r.step.skill === 'graph.query');
    const evidence: AssistantEvidence[] = results.map((r) => ({
      skill: r.step.skill,
      store: r.store,
      query: r.query,
      params: r.params,
      rows: r.rows.length,
      durationMs: r.durationMs,
      error: r.error,
    }));
    return {
      text,
      cypher: graphStep?.query ?? '',
      rows: graphStep?.rows ?? [],
      cis,
      intent: c.intent,
      confidence: Number(c.confidence.toFixed(ASSISTANT.decimals)),
      figures: [],
      evidence,
      followUps,
      clarification,
      grounded,
      conversationId: '',
      turnId: '',
    };
  }

  private async finish(
    tenantId: string,
    actor: string,
    question: string,
    c: Classification,
    answer: AssistantAnswerView,
    started: number,
    outcome: Outcome,
    thread: Thread,
  ): Promise<AssistantAnswerView> {
    const intent: AssistantIntent = c.intent;
    this.metrics.assistantQuestions.inc({ intent, outcome });
    this.metrics.assistantDuration.observe({ intent }, (Date.now() - started) / TIME.msPerSecond);
    // REQ-AI-008: the turn is persisted as returned, with the resolved reading the next question may lean on.
    const recorded = await this.conversations.record(tenantId, actor, thread.conversationId, question, thread.locale, outcome, {
      text: answer.text,
      cypher: answer.cypher,
      rows: answer.rows,
      ciIds: answer.cis.map((ci) => ci.id),
      intent: answer.intent,
      confidence: answer.confidence,
      figures: answer.figures,
      evidence: answer.evidence,
      followUps: answer.followUps,
      clarification: answer.clarification,
      grounded: answer.grounded,
      context: { intent: c.intent, entities: { ...turnContextOf(c).entities } },
    });
    answer.conversationId = recorded.conversationId;
    answer.turnId = recorded.turnId;
    const failures = answer.evidence.filter((e) => e.error !== null);
    await this.outbox.transaction(tenantId, async (tx) => {
      if (outcome === 'failed' || failures.length > 0) {
        await tx.emit({
          type: 'openmap.assistant.query.failed',
          subject: tenantId,
          data: {
            question,
            intent,
            matched: c.matched,
            failures: failures.map((f) => ({ skill: f.skill, query: f.query, error: f.error })),
            by: actor,
          },
        });
      }
      if (outcome !== 'failed') {
        await tx.emit({
          type: 'openmap.assistant.query.answered',
          subject: tenantId,
          data: {
            question,
            intent,
            confidence: answer.confidence,
            skills: answer.evidence.map((e) => e.skill),
            rows: answer.evidence.reduce((n, e) => n + e.rows, 0),
            clarified: answer.clarification !== null,
            grounded: answer.grounded,
            by: actor,
          },
        });
      }
    });
    return answer;
  }
}
