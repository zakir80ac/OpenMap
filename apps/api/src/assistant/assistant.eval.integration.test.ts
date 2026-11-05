// T-143 REQ-AI-007 (ADR-028) — the evaluation set through the real pipeline: every question in
// apps/assistant/src/eval/questions.ts is asked over GraphQL against the compose stack (Postgres, Memgraph,
// ClickHouse and the LLM profile) for the most populated tenant, and the answer must carry the expected intent, run
// the expected skill first (or ask back), yield a figure where the estate holds one and name the expected query
// fragment. The run fails under ASSISTANT.evalAccuracyMin; the per-question record is the evidence
// (docs/evidence/assistant-conversation.md).
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type GenerateKeyPairResult } from 'jose';
import { EVAL_QUESTIONS, type EvalQuestion } from '@openmap/assistant';
import { loadEnv } from '@openmap/config';
import { ASSISTANT, TIME } from '@openmap/constants';
import { createPrismaClient } from '@openmap/db';
import { AppModule } from '../app.module.js';
import { JWKS, realmUrl } from '../auth/jwks.provider.js';
import { SIGNING_ALGORITHM } from '../auth/auth.service.js';
import { ROLES } from '../auth/roles.js';
import type { AssistantAnswerView } from './assistant.types.js';

const env = loadEnv();
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

const MUTATION =
  'mutation AskAssistant($question: String!, $locale: String) { askAssistant(question: $question, locale: $locale) { text cypher rows intent confidence grounded figures { label value unit } evidence { skill store query params rows durationMs error } followUps clarification { question options { label value } } cis { id displayName } } }';

async function ask(
  question: string,
  locale: string,
): Promise<GraphQLResponse<{ askAssistant: AssistantAnswerView }>> {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    payload: { query: MUTATION, variables: { question, locale } },
  });
  return JSON.parse(res.body) as GraphQLResponse<{ askAssistant: AssistantAnswerView }>;
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
  if (
    q.expect.queryMentions !== null &&
    // SQL is parameterised: the attribute key or relationship type sits in the bound parameters, not the text.
    !answer.evidence.some(
      (e) =>
        e.query.includes(q.expect.queryMentions ?? '') ||
        JSON.stringify(e.params).includes(q.expect.queryMentions ?? ''),
    )
  )
    why.push('no evidence query mentions ' + q.expect.queryMentions);
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

describe('assistant evaluation set (integration)', () => {
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
      },
      QUESTION_TIMEOUT_MS,
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
