// T-113 REQ-AI-001 — golden question set: every question is answered by the real model through the real
// pipeline against the real graph (compose stack: Memgraph + the LLM profile), or explicitly refused with a
// reason. Questions whose answer the estate must contain also assert rows. The tenant is the most populated
// one in the graph, so the set runs on any seeded stack without a configured id.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '@openmap/config';
import { createGraphRepository, type GraphRepository } from '@openmap/graph';
import { createLlmClient, type LlmClient } from './llm.js';
import { ask, AssistantError } from './nl2cypher.js';

interface GoldenQuestion {
  question: string;
  /** Rows the estate must return; 0 means "runs" is enough (the estate may legitimately hold nothing). */
  minRows: number;
  /** Labels or keywords the generated query must mention. */
  mentions: RegExp;
}

const GOLDEN: GoldenQuestion[] = [
  { question: 'How many hosts are there?', minRows: 1, mentions: /:Host\b/ },
  { question: 'How many hosts run each operating system?', minRows: 1, mentions: /OperatingSystem/ },
  { question: 'Which business services are degraded right now?', minRows: 0, mentions: /BusinessService/ },
  { question: 'Which business services are down?', minRows: 0, mentions: /BusinessService/ },
  { question: 'List the virtual machines and the hypervisor each one runs on', minRows: 1, mentions: /:Vm\b/ },
  { question: 'Which racks hold the most hosts?', minRows: 1, mentions: /:Rack\b/ },
  { question: 'Which racks draw the most power?', minRows: 0, mentions: /Rack|Pdu/ },
  { question: 'Which subnets are more than 70% used?', minRows: 0, mentions: /Subnet/ },
  { question: 'Which software is affected by a vulnerability?', minRows: 1, mentions: /Vulnerability/ },
  { question: 'How many network devices are in each site?', minRows: 1, mentions: /NetworkDevice/ },
  { question: 'Which applications are part of the most business services?', minRows: 1, mentions: /PART_OF_SERVICE/ },
  { question: 'Count the CIs per layer', minRows: 1, mentions: /layer/ },
];

const env = loadEnv();
let repo: GraphRepository;
let llm: LlmClient;
let tenantId = '';
const outcomes: Array<{ question: string; outcome: string; rows: number; cypher: string }> = [];

beforeAll(async () => {
  repo = createGraphRepository(env);
  llm = createLlmClient(env);
  const populated = await repo.readOnly<{ tenantId: string; n: number }>('MATCH (s:Ci:BusinessService) WHERE s.validTo IS NULL RETURN s.tenantId AS tenantId, count(s) AS n ORDER BY n DESC LIMIT 1', {});
  tenantId = populated[0]?.tenantId ?? '';
  expect(tenantId, 'the graph holds a tenant with business services').not.toBe('');
});

afterAll(async () => {
  // The per-question record is the evidence attached to the tracker row (docs/evidence/assistant.md).
  console.log(JSON.stringify({ tenantId, model: env.LLM_MODEL, outcomes }, null, 1));
  await repo.close();
});

describe('assistant golden set', () => {
  for (const g of GOLDEN) {
    it(g.question, async () => {
      try {
        const a = await ask(g.question, tenantId, llm, repo);
        outcomes.push({ question: g.question, outcome: 'answered', rows: a.rows.length, cypher: a.cypher });
        expect(a.cypher).toMatch(g.mentions);
        expect(a.cypher).toContain('$tenantId');
        expect(a.rows.length).toBeGreaterThanOrEqual(g.minRows);
      } catch (err) {
        if (!(err instanceof AssistantError)) throw err;
        outcomes.push({ question: g.question, outcome: 'refused: ' + err.message, rows: 0, cypher: err.cypher ?? '' });
        // A refusal is the product's contract for a question it cannot answer safely; it is a failure only when
        // the estate is known to hold the answer.
        expect(g.minRows, 'refused although the estate holds the answer: ' + err.message).toBe(0);
      }
    });
  }
});
