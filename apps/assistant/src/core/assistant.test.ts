// T-011 REQ-AI-001
import { describe, expect, it } from 'vitest';
import { ASSISTANT } from '@openmap/constants';
import type { GraphRepository } from '@openmap/graph';
import { schemaGrounding, systemPrompt } from './grounding.js';
import { createLlmClient, type LlmClient } from './llm.js';
import { ask, boundVariables, enforceLimit, extractCypher, normaliseHops, prepareCypher, referencedVariables, scopeToTenant, validateCypher } from './nl2cypher.js';
import { workedExamples } from './grounding.js';

describe('grounding', () => {
  it('lists every type label and relationship from the contract', () => {
    const g = schemaGrounding();
    expect(g).toContain(':Ci:BusinessService');
    expect(g).toContain('PART_OF_SERVICE');
    expect(systemPrompt()).toContain('read-only');
  });
  it('shows only complete examples that pass the validator, never a fragment with a free variable', () => {
    const prompt = systemPrompt();
    expect(prompt).not.toMatch(/\$name\b/);
    expect(prompt).not.toMatch(/WHERE n\./);
    for (const e of workedExamples()) {
      expect(prompt).toContain(e.cypher);
      expect(() => validateCypher(e.cypher)).not.toThrow();
      expect(scopeToTenant(e.cypher)).toBe(e.cypher);
    }
  });
});

describe('variable binding and tenant scoping', () => {
  it('finds the variables a query binds and the ones it dereferences', () => {
    const q = "MATCH (c:Ci {name:'x'})<-[r:DEPENDS_ON*1..6]-(x)-[:PART_OF_SERVICE]->(s:BusinessService) WHERE n.tenantId = $tenantId RETURN count(x) AS hits, s.name";
    expect([...boundVariables(q)].sort()).toEqual(['c', 'hits', 'r', 's', 'x']);
    expect([...referencedVariables(q)].sort()).toEqual(['n', 's']);
    expect(() => validateCypher(q)).toThrow(/variable n is used but never introduced in a MATCH pattern; the query binds c, x, s, r, hits/);
  });
  it('ignores identifiers inside string literals', () => {
    const q = "MATCH (h:Host) WHERE h.tenantId = $tenantId AND h.name = 'n.x (y) AS z' RETURN h.name";
    expect([...boundVariables(q)]).toEqual(['h']);
    expect([...referencedVariables(q)]).toEqual(['h']);
  });
  it('scopes every unscoped node variable to the tenant, joining an existing WHERE or opening one', () => {
    expect(scopeToTenant('MATCH (h:Host) RETURN count(h)')).toBe('MATCH (h:Host) WHERE h.tenantId = $tenantId AND h.validTo IS NULL RETURN count(h)');
    expect(scopeToTenant("MATCH (d:Ci {health: 'down'})\nRETURN d.name\nLIMIT 5")).toBe("MATCH (d:Ci {health: 'down'}) WHERE d.tenantId = $tenantId AND d.validTo IS NULL\nRETURN d.name\nLIMIT 5");
    expect(scopeToTenant("MATCH (o:OperatingSystem)-[:RUNS_ON]->(h:Host) WHERE o.tenantId = $tenantId AND h.name <> 'a' RETURN o.name, count(h)")).toBe(
      "MATCH (o:OperatingSystem)-[:RUNS_ON]->(h:Host) WHERE h.tenantId = $tenantId AND h.validTo IS NULL AND o.tenantId = $tenantId AND h.name <> 'a' RETURN o.name, count(h)",
    );
    expect(scopeToTenant('MATCH (a:Host) WITH a MATCH (a)-[:LOCATED_IN]->(r:Rack) RETURN r.name')).toBe(
      'MATCH (a:Host) WHERE a.tenantId = $tenantId AND a.validTo IS NULL WITH a MATCH (a)-[:LOCATED_IN]->(r:Rack) WHERE r.tenantId = $tenantId AND r.validTo IS NULL RETURN r.name',
    );
  });
  it('rejects labels, relationship types, properties and hop directions the graph does not have', () => {
    const scoped = (pattern: string, alias: string): string => scopeToTenant('MATCH ' + pattern + ' WHERE ' + alias + '.tenantId = $tenantId RETURN ' + alias + '.name');
    expect(() => validateCypher(scoped('(r:Rack)-[:POWERED_BY]->(p:PowerSocket)', 'r'))).toThrow(/label PowerSocket does not exist/);
    expect(() => validateCypher(scoped('(r:Rack)-[:FEEDS]->(p:Pdu)', 'r'))).toThrow(/relationship type FEEDS does not exist/);
    expect(() => validateCypher(scoped('(s:Subnet)', 's') + ', s.usedPercentage')).toThrow(/property usedPercentage does not exist/);
    expect(() => validateCypher(scoped("(s:Subnet {cidr: 'x'})", 's'))).toThrow(/property cidr does not exist/);
    expect(() => validateCypher(scoped('(s:BusinessService)-[:PART_OF_SERVICE]->(a:Application)', 's'))).toThrow(/PART_OF_SERVICE goes from Application to BusinessService.*write \(Application\)-\[:PART_OF_SERVICE\]->\(BusinessService\)/);
    expect(() => validateCypher(scoped('(h:Hypervisor)<-[:HOSTED_ON]-(v:Vm)', 'h'))).not.toThrow();
    expect(() => validateCypher(scoped('(v:Vm)<-[:HOSTED_ON]-(h:Hypervisor)', 'v'))).toThrow(/HOSTED_ON goes from Vm to Hypervisor/);
    // Unknown combinations pass: only a known pair traversed backwards is wrong by construction.
    expect(() => validateCypher(scoped('(d:Database)-[:HOSTED_ON]->(h:Host)', 'd'))).not.toThrow();
    expect(() => validateCypher(scoped('(a:Application)-[:DEPENDS_ON|RUNS_ON*1..3]->(b:Ci)', 'a'))).not.toThrow();
    expect(() => validateCypher(scoped('(h:Host)-[r:LOCATED_IN]->(k:Rack)', 'h') + ', r.since, count(h) AS n')).not.toThrow();
  });
  it('turns known hops the right way round and fixes the type when the two labels have exactly one', () => {
    expect(normaliseHops('MATCH (s:BusinessService)-[:PART_OF_SERVICE]->(a:Application) RETURN a.name')).toBe('MATCH (s:BusinessService)<-[:PART_OF_SERVICE]-(a:Application) RETURN a.name');
    expect(normaliseHops('MATCH (vm:Vm)-[:RUNS_ON]->(hv:Hypervisor) RETURN vm.name')).toBe('MATCH (vm:Vm)-[:HOSTED_ON]->(hv:Hypervisor) RETURN vm.name');
    expect(normaliseHops('MATCH (hv:Hypervisor)-[:HOSTS]->(vm:Vm)-[:RUNS_ON]->(h:Host) RETURN vm.name')).toBe('MATCH (hv:Hypervisor)<-[:HOSTED_ON]-(vm:Vm)-[:RUNS_ON]->(h:Host) RETURN vm.name');
    // Correct hops, unrelated labels, multi-type and variable-length hops are left alone.
    for (const q of [
      'MATCH (a:Application)-[:PART_OF_SERVICE]->(s:BusinessService) RETURN s.name',
      'MATCH (d:Database)-[:HOSTED_ON]->(h:Host) RETURN d.name',
      'MATCH (a:Application)-[:DEPENDS_ON|RUNS_ON*1..3]->(b:Ci) RETURN b.name',
      "MATCH (h:Host) WHERE h.name = '(Vm)-[:RUNS_ON]->(Hypervisor)' RETURN h.name",
    ]) expect(normaliseHops(q)).toBe(q);
  });
  it('leaves validity alone when the query already reasons about time', () => {
    expect(scopeToTenant('MATCH (h:Host) WHERE h.validTo < $now RETURN h.name')).toBe('MATCH (h:Host) WHERE h.tenantId = $tenantId AND h.validTo < $now RETURN h.name');
  });
  it('turns the small model’s typical mistakes into runnable or precisely rejected queries', () => {
    // Recorded from the 1.5B model on the dev stack: the prompt fragment copied verbatim, and a free `n`.
    const impactCopy = "MATCH (c:Ci {name:$name})<-[:DEPENDS_ON|RUNS_ON*1..6]-(x)-[:PART_OF_SERVICE]->(s:BusinessService) WHERE n.tenantId = $tenantId AND x.name = 'ledger-db-01' RETURN s.name";
    expect(() => validateCypher(prepareCypher(impactCopy))).toThrow(/unknown parameter \$name/);
    const unbound = "MATCH (s:BusinessService) WHERE n.tenantId = $tenantId AND s.health = 'down' RETURN s.name";
    expect(() => validateCypher(prepareCypher(unbound))).toThrow(/variable n is used but never introduced/);
    const badHealth = "MATCH (d:Ci {health: 'unhealthy'})\nRETURN d.name, d.layer\nORDER BY d.health DESC\nLIMIT 5";
    expect(() => validateCypher(prepareCypher(badHealth))).toThrow(/'unhealthy' is not a health value; health is one of healthy, degraded, down, unknown/);
    const noScope = 'MATCH (h:Host) RETURN count(h)';
    const prepared = prepareCypher(noScope);
    expect(prepared).toContain('h.tenantId = $tenantId');
    expect(() => validateCypher(prepared)).not.toThrow();
  });
});

describe('cypher extraction and validation', () => {
  it('strips fences and prose', () => {
    expect(extractCypher('Here you go:\n```cypher\nMATCH (n:Ci) WHERE n.tenantId = $tenantId RETURN n.name;\n```')).toBe('MATCH (n:Ci) WHERE n.tenantId = $tenantId RETURN n.name');
  });
  it('rejects an invented parameter', () => {
    expect(() => validateCypher('MATCH (n:Ci) WHERE n.tenantId = $tenantId AND n.name = $name RETURN n')).toThrow(/unknown parameter \$name/);
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
  it('repairs a query the engine rejects by feeding the error back to the model', async () => {
    const turns: string[] = [];
    const flaky: LlmClient = {
      complete: async (messages) => {
        turns.push(messages[messages.length - 1]?.content ?? '');
        const repaired = messages.some((m) => m.role === 'user' && m.content.includes('rejected'));
        return { text: repaired ? 'MATCH (s:BusinessService) WHERE s.tenantId = $tenantId RETURN s.name AS name' : 'MATCH (s:BusinessService) WHERE s.tenantId = $tenantId RETURN count(s), s.name', promptTokens: 1, completionTokens: 1 };
      },
    };
    let calls = 0;
    const engine = { readOnly: async <T,>(cypher: string): Promise<T[]> => { calls++; if (cypher.includes('count(s), s.name')) throw new Error('Aggregation functions are only allowed in WITH and RETURN.'); return [{ name: 'Payments' }] as T[]; } } as unknown as GraphRepository;
    const a = await ask('which services?', 't-1', flaky, engine);
    expect(calls).toBe(2);
    expect(turns[1]).toContain('Aggregation functions');
    expect(a.rows).toEqual([{ name: 'Payments' }]);
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
