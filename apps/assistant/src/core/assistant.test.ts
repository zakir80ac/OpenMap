// T-011 REQ-AI-001
import { describe, expect, it } from 'vitest';
import { ASSISTANT } from '@openmap/constants';
import type { GraphRepository } from '@openmap/graph';
import { schemaGrounding, systemPrompt } from './grounding.js';
import { createLlmClient, type LlmClient } from './llm.js';
import { ask, enforceLimit, extractCypher, validateCypher } from './nl2cypher.js';

describe('grounding', () => {
  it('lists every type label and relationship from the contract', () => {
    const g = schemaGrounding();
    expect(g).toContain(':Ci:BusinessService');
    expect(g).toContain('PART_OF_SERVICE');
    expect(systemPrompt()).toContain('read-only');
  });
});

describe('cypher extraction and validation', () => {
  it('strips fences and prose', () => {
    expect(extractCypher('Here you go:\n```cypher\nMATCH (n:Ci) WHERE n.tenantId = $tenantId RETURN n.name;\n```')).toBe('MATCH (n:Ci) WHERE n.tenantId = $tenantId RETURN n.name');
  });
  it('rejects writes, missing tenant scope and missing RETURN', () => {
    expect(() => validateCypher('MATCH (n) WHERE n.tenantId = $tenantId DETACH DELETE n')).toThrow();
    expect(() => validateCypher('MATCH (n) RETURN n')).toThrow(/tenant/);
    expect(() => validateCypher('MATCH (n) WHERE n.tenantId = $tenantId')).toThrow(/returns nothing/);
    expect(() => validateCypher('MATCH (n) WHERE n.tenantId = $tenantId RETURN n')).not.toThrow();
  });
  it('adds a LIMIT when absent and leaves counts alone', () => {
    expect(enforceLimit('MATCH (n) RETURN n')).toContain('LIMIT ' + String(ASSISTANT.maxRowsReturned));
    expect(enforceLimit('MATCH (n) RETURN count(n)')).not.toContain('LIMIT');
    expect(enforceLimit('MATCH (n) RETURN n LIMIT 5')).not.toContain(String(ASSISTANT.maxRowsReturned));
  });
});

describe('ask', () => {
  const llm: LlmClient = { complete: async () => ({ text: 'MATCH (s:BusinessService) WHERE s.tenantId = $tenantId AND s.health = "down" RETURN s.name AS name', promptTokens: 1, completionTokens: 1 }) };
  const repo = { readOnly: async (cypher: string) => (cypher.includes('LIMIT') ? [{ name: 'Online banking' }] : []) } as unknown as GraphRepository;
  it('runs the validated query and summarises', async () => {
    const a = await ask('which services are down?', 't-1', llm, repo);
    expect(a.cypher).toContain('LIMIT');
    expect(a.rows).toHaveLength(1);
    expect(a.text).toContain('Online banking');
  });
  it('refuses when the model emits a write', async () => {
    const bad: LlmClient = { complete: async () => ({ text: 'MATCH (n) WHERE n.tenantId = $tenantId SET n.health = "down" RETURN n', promptTokens: 1, completionTokens: 1 }) };
    await expect(ask('break things', 't-1', bad, repo)).rejects.toThrow();
  });
});

describe('llm client', () => {
  it('posts an OpenAI-compatible request and parses the reply', async () => {
    let captured: { url: string; body: string } | null = null;
    const fetchImpl: typeof fetch = async (url, init) => {
      captured = { url: String(url), body: String(init?.body) };
      return new Response(JSON.stringify({ choices: [{ message: { content: 'MATCH (n) RETURN n' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
    };
    const client = createLlmClient({ LLM_BASE_URL: 'http://llm.test/v1', LLM_MODEL: 'local-model', LLM_API_KEY: 'k', LLM_TIMEOUT_MS: 1000 }, fetchImpl);
    const r = await client.complete([{ role: 'user', content: 'hi' }]);
    expect(r.text).toBe('MATCH (n) RETURN n');
    expect(r.promptTokens).toBe(10);
    expect(captured!.url).toBe('http://llm.test/v1/chat/completions');
    expect(JSON.parse(captured!.body)).toMatchObject({ model: 'local-model', temperature: ASSISTANT.temperature });
  });
});
