// REQ-PERF-002 — k6 budget test: impact query p95 under PERF_BUDGETS.impactQuery100kP95Ms against a
// 100k-node estate. Run with environment: API_URL (GraphQL endpoint), TOKEN (bearer), ROOT_IDS (comma list).
// k6 is AGPL and runs as a separate process (ADR-001); this script carries no OpenMap code.
import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const budgetMs = Number(__ENV.BUDGET_MS || '1000');
const apiUrl = __ENV.API_URL;
const token = __ENV.TOKEN;
const roots = (__ENV.ROOT_IDS || '').split(',').filter(Boolean);
const impactDuration = new Trend('openmap_impact_ms', true);

export const options = {
  scenarios: {
    impact: { executor: 'constant-vus', vus: Number(__ENV.VUS || '8'), duration: __ENV.DURATION || '60s' },
  },
  thresholds: {
    openmap_impact_ms: ['p(95)<' + budgetMs],
    http_req_failed: ['rate<0.01'],
  },
};

const query = `query Impact($id: UUID!) { impact(ciId: $id, direction: upstream, maxDepth: 0) { durationMs services { service { id name } predicted } nodes { depth } } }`;

export default function () {
  if (!apiUrl || !token || roots.length === 0) throw new Error('API_URL, TOKEN and ROOT_IDS are required');
  const id = roots[Math.floor(Math.random() * roots.length)];
  const started = Date.now();
  const res = http.post(apiUrl, JSON.stringify({ query, variables: { id } }), {
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
  });
  impactDuration.add(Date.now() - started);
  check(res, {
    'status 200': (r) => r.status === 200,
    'no graphql errors': (r) => !String(r.body).includes('"errors"'),
  });
}

// k6 v2 consolidates `options` in handleSummary; the VU count is read from the environment it came from.
export function handleSummary(data) {
  const p95 = data.metrics.openmap_impact_ms ? data.metrics.openmap_impact_ms.values['p(95)'] : null;
  const result = {
    name: 'impact-query',
    p95Ms: p95,
    budgetMs,
    vus: Number(__ENV.VUS || '8'),
    generatedAt: new Date().toISOString(),
  };
  return {
    'results/impact-query.json': JSON.stringify(result, null, 2),
    stdout: JSON.stringify(result) + '\n',
  };
}
