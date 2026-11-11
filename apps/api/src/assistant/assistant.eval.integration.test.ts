// T-143 REQ-AI-007 T-146 REQ-AI-008 (ADR-028) — the evaluation set through the real pipeline: every question in
// apps/assistant/src/eval/questions.ts is asked over GraphQL against the compose stack (Postgres, Memgraph,
// ClickHouse and the LLM profile) for the most populated tenant, and the answer must carry the expected intent, run
// the expected skill first (or ask back), yield a figure where the estate holds one and name the expected query
// fragments. The multi-turn cases are asked in one conversation each, so the later turns lean on the earlier; the
// conversation is then listed, read back with its turns and deleted. The run fails under ASSISTANT.evalAccuracyMin;
// the per-question record is the evidence (docs/evidence/assistant-conversations.md).
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type GenerateKeyPairResult } from 'jose';
import { EVAL_CONVERSATIONS, EVAL_QUESTIONS, type EvalQuestion } from '@openmap/assistant';
import { loadEnv } from '@openmap/config';
import { ASSISTANT, TIME } from '@openmap/constants';
import { createPrismaClient } from '@openmap/db';
import { AppModule } from '../app.module.js';
import { JWKS, realmUrl } from '../auth/jwks.provider.js';
import { SIGNING_ALGORITHM } from '../auth/auth.service.js';
import { ROLES } from '../auth/roles.js';
import type { AssistantAnswerView, ConversationView, TurnView } from './assistant.types.js';

const env = loadEnv();
// The evaluation asks the real model about a seeded estate. A stack without a model (the CI integration job starts
// none) skips it, says so, and leaves the committed evidence alone.
const LLM_PROBE_MS = 5_000;
const llmUp = await fetch(new URL('models', env.LLM_BASE_URL.endsWith('/') ? env.LLM_BASE_URL : env.LLM_BASE_URL + '/'), {
  headers: { authorization: 'Bearer ' + env.LLM_API_KEY },
  signal: AbortSignal.timeout(LLM_PROBE_MS),
}).then((r) => r.ok, () => false);
if (!llmUp) console.warn('assistant evaluation skipped: no model answers at ' + env.LLM_BASE_URL);
const prisma = createPrismaClient(env);
const KID = 'openmap-eval-key';
const QUESTION_TIMEOUT_MS = 3 * TIME.secondsPerMinute * TIME.msPerSecond;

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

interface Outcome {
  id: string;
  question: string;
  intent: string;
  skill: string | null;
  figures: number;
  text: string;
  grounded: boolean;
  evidence: string[];
  ok: boolean;
  why: string[];
}

let app: NestFastifyApplication;
let keys: GenerateKeyPairResult;
let token = '';
let tenantId = '';
const outcomes: Outcome[] = [];

const ANSWER_FIELDS =
  'text cypher rows intent confidence grounded conversationId turnId figures { label value unit } evidence { skill store query params rows durationMs error } followUps clarification { question options { label value } } cis { id displayName }';
const MUTATION =
  'mutation AskAssistant($question: String!, $locale: String, $conversationId: UUID) { askAssistant(question: $question, locale: $locale, conversationId: $conversationId) { ' +
  ANSWER_FIELDS +
  ' } }';
const CONVERSATIONS_QUERY = 'query Conversations { conversations { id title turnCount createdAt updatedAt } }';
const CONVERSATION_QUERY =
  'query Conversation($id: UUID!) { conversation(id: $id) { id title turnCount turns { id at question locale answer { ' +
  ANSWER_FIELDS +
  ' } } } }';
const DELETE_MUTATION = 'mutation DeleteConversation($id: UUID!) { deleteConversation(id: $id) }';

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<GraphQLResponse<T>> {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    payload: { query, variables },
  });
  return JSON.parse(res.body) as GraphQLResponse<T>;
}

function ask(
  question: string,
  locale: string,
  conversationId: string | null = null,
): Promise<GraphQLResponse<{ askAssistant: AssistantAnswerView }>> {
  return graphql<{ askAssistant: AssistantAnswerView }>(MUTATION, { question, locale, conversationId });
}

async function nameOf(type: EvalQuestion['nameOf']): Promise<string> {
  if (type === null) return '';
  const row = await prisma.ci.findFirst({
    where: { tenantId, type, validTo: null },
    orderBy: { name: 'asc' },
    select: { name: true },
  });
  return row?.name ?? '';
}

function check(q: EvalQuestion, answer: AssistantAnswerView): string[] {
  const why: string[] = [];
  if (answer.intent !== q.expect.intent)
    why.push('intent ' + answer.intent + ' (expected ' + q.expect.intent + ')');
  const first = answer.evidence[0]?.skill ?? null;
  if (q.expect.skill === null) {
    if (answer.clarification === null && answer.evidence.length > 0)
      why.push('expected a clarification, got skill ' + String(first));
  } else if (first !== q.expect.skill)
    why.push('skill ' + String(first) + ' (expected ' + q.expect.skill + ')');
  if (q.expect.figure && !answer.figures.some((f) => f.value > 0)) why.push('no figure above zero');
  // SQL is parameterised: the attribute key or relationship type sits in the bound parameters, not the text.
  const mentioned = (fragment: string): boolean =>
    answer.evidence.some((e) => e.query.includes(fragment) || JSON.stringify(e.params).includes(fragment));
  for (const fragment of [q.expect.queryMentions, ...(q.expect.mentions ?? [])])
    if (fragment !== null && !mentioned(fragment)) why.push('no evidence query mentions ' + fragment);
  if (answer.evidence.some((e) => e.error !== null))
    why.push(
      'a step failed: ' +
        answer.evidence
          .map((e) => e.error)
          .filter((e) => e !== null)
          .join('; '),
    );
  return why;
}

describe.runIf(llmUp)('assistant evaluation set (integration)', () => {
  beforeAll(async () => {
    // The tenant with the most business services is the seeded synthetic estate, whatever id it was given.
    const populated = await prisma.ci.groupBy({
      by: ['tenantId'],
      where: { type: 'business_service', validTo: null },
      _count: { _all: true },
      orderBy: { _count: { tenantId: 'desc' } },
      take: 1,
    });
    tenantId = populated[0]?.tenantId ?? '';
    expect(tenantId, 'a seeded tenant with business services').not.toBe('');
    keys = await generateKeyPair(SIGNING_ALGORITHM);
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: SIGNING_ALGORITHM, use: 'sig' };
    token = await new SignJWT({
      tenant: tenantId,
      preferred_username: 'eval',
      realm_access: { roles: [ROLES.analyst] },
      azp: env.KEYCLOAK_CLIENT_ID,
    })
      .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: KID })
      .setIssuer(realmUrl(env).toString())
      .setSubject('eval-' + randomUUID())
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(keys.privateKey);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JWKS)
      .useValue(createLocalJWKSet({ keys: [jwk] }))
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: ['error', 'warn'],
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, QUESTION_TIMEOUT_MS);

  afterAll(async () => {
    const passed = outcomes.filter((o) => o.ok).length;
    // The per-question record is committed evidence (docs/evidence/assistant-eval.json), not test output.
    const record = {
      capturedAt: new Date().toISOString(),
      tenantId,
      model: env.LLM_MODEL,
      prose: env.ASSISTANT_PROSE,
      passed,
      total: outcomes.length,
      outcomes,
    };
    writeFileSync(
      fileURLToPath(new URL('../../../../docs/evidence/assistant-eval.json', import.meta.url)),
      JSON.stringify(record, null, 1) + '\n',
      'utf8',
    );
    // Every single question opened a conversation for the eval user; the record above is the evidence, not the rows.
    await prisma.assistantConversation.deleteMany({ where: { tenantId, userId: 'eval' } });
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  });

  for (const q of EVAL_QUESTIONS) {
    it(
      q.id + ': ' + q.question,
      async () => {
        const question = q.question.replace('{name}', await nameOf(q.nameOf));
        const res = await ask(question, q.locale);
        const answer = res.data?.askAssistant;
        if (answer === undefined) {
          outcomes.push({
            id: q.id,
            question,
            intent: 'error',
            skill: null,
            figures: 0,
            text: res.errors?.[0]?.message ?? '',
            grounded: false,
            evidence: [],
            ok: false,
            why: ['GraphQL error: ' + (res.errors?.[0]?.message ?? '')],
          });
          throw new Error(res.errors?.[0]?.message ?? 'no answer');
        }
        const why = check(q, answer);
        outcomes.push({
          id: q.id,
          question,
          intent: answer.intent,
          skill: answer.evidence[0]?.skill ?? null,
          figures: answer.figures.length,
          text: answer.text,
          grounded: answer.grounded,
          evidence: answer.evidence.map((e) => e.skill + ':' + e.store + ':' + String(e.rows)),
          ok: why.length === 0,
          why,
        });
        expect(answer.text.length).toBeGreaterThan(0);
        expect(answer.text).not.toMatch(/\{\w+\}/);
        expect(answer.conversationId).toMatch(/^[0-9a-f-]{36}$/);
      },
      QUESTION_TIMEOUT_MS,
    );
  }

  // REQ-AI-008: each multi-turn case runs in one conversation; the follow-up must be read against the first turn.
  for (const conversation of EVAL_CONVERSATIONS) {
    it(
      conversation.id + ': ' + conversation.turns.map((t) => t.question).join(' / '),
      async () => {
        let conversationId: string | null = null;
        for (const q of conversation.turns) {
          const question = q.question.replace('{name}', await nameOf(q.nameOf));
          const res = await ask(question, q.locale, conversationId);
          const answer = res.data?.askAssistant;
          if (answer === undefined) {
            outcomes.push({ id: q.id, question, intent: 'error', skill: null, figures: 0, text: res.errors?.[0]?.message ?? '', grounded: false, evidence: [], ok: false, why: ['GraphQL error: ' + (res.errors?.[0]?.message ?? '')] });
            throw new Error(res.errors?.[0]?.message ?? 'no answer');
          }
          if (conversationId !== null) expect(answer.conversationId).toBe(conversationId);
          conversationId = answer.conversationId;
          const why = check(q, answer);
          outcomes.push({ id: q.id, question, intent: answer.intent, skill: answer.evidence[0]?.skill ?? null, figures: answer.figures.length, text: answer.text, grounded: answer.grounded, evidence: answer.evidence.map((e) => e.skill + ':' + e.store + ':' + String(e.rows)), ok: why.length === 0, why });
        }
        // The conversation is listed for its owner, reads back with every turn, and is gone once deleted.
        const list = await graphql<{ conversations: ConversationView[] }>(CONVERSATIONS_QUERY, {});
        const listed = list.data?.conversations.find((c) => c.id === conversationId);
        expect(listed?.turnCount).toBe(conversation.turns.length);
        const read = await graphql<{ conversation: (ConversationView & { turns: TurnView[] }) | null }>(CONVERSATION_QUERY, { id: conversationId });
        const turns = read.data?.conversation?.turns ?? [];
        expect(turns.map((t) => t.question)).toEqual(await Promise.all(conversation.turns.map(async (t) => t.question.replace('{name}', await nameOf(t.nameOf)))));
        expect(turns.every((t) => t.answer.text.length > 0)).toBe(true);
        const deleted = await graphql<{ deleteConversation: boolean }>(DELETE_MUTATION, { id: conversationId });
        expect(deleted.data?.deleteConversation).toBe(true);
        const after = await graphql<{ conversation: ConversationView | null }>(CONVERSATION_QUERY, { id: conversationId });
        expect(after.data?.conversation).toBeNull();
      },
      QUESTION_TIMEOUT_MS * conversation.turns.length,
    );
  }

  it('reaches the accuracy floor', () => {
    const passed = outcomes.filter((o) => o.ok).length;
    const failed = outcomes.filter((o) => !o.ok).map((o) => o.id + ': ' + o.why.join(', '));
    expect(passed / Math.max(1, outcomes.length), failed.join('\n')).toBeGreaterThanOrEqual(
      ASSISTANT.evalAccuracyMin,
    );
  });
});
