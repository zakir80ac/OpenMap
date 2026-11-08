// REQ-UI-027 — k6 budget test: the Health and telemetry table's page (telemetryFleet) p95 under
// PERF_BUDGETS.screenInteractionP95Ms on a 100k-CI estate, across sort keys, category, health and text filters and
// offsets as a person scrolling and filtering the table sends them. Environment: API_URL (GraphQL endpoint), TOKEN.
// k6 is AGPL and runs as a separate process (ADR-001); this script carries no OpenMap code.
import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const budgetMs = Number(__ENV.BUDGET_MS || '100');
const pageSize = Number(__ENV.PAGE_SIZE || '200');
const apiUrl = __ENV.API_URL;
const token = __ENV.TOKEN;
const pageDuration = new Trend('openmap_telemetry_fleet_ms', true);

export const options = {
  scenarios: {
    fleet: { executor: 'constant-vus', vus: Number(__ENV.VUS || '8'), duration: __ENV.DURATION || '60s' },
  },
  thresholds: {
    openmap_telemetry_fleet_ms: ['p(95)<' + budgetMs],
    http_req_failed: ['rate<0.01'],
  },
};

const sorts = ['health', 'cpu', 'memory', 'iops', 'throughput', 'apdex', 'name'];
const filters = [
  {},
  { layers: ['hardware'] },
  { layers: ['virtualization', 'containers'] },
  { health: ['down', 'degraded'] },
  { layers: ['network_security'], text: 'ryd' },
  { text: 'db' },
];
const offsets = [0, pageSize, pageSize * 10];
const query =
  'query F($filter: FleetFilter, $sort: FleetSort, $first: Int, $offset: Int) { telemetryFleet(filter: $filter, sort: $sort, first: $first, offset: $offset) { total healthy degraded down unknown items { ci { id displayName type layer } site address health cpu memory iops throughput apdex observedAt } } }';

const pick = (list) => list[Math.floor(Math.random() * list.length)];

export default function () {
  if (!apiUrl || !token) throw new Error('API_URL and TOKEN are required');
  const variables = { filter: pick(filters), sort: pick(sorts), first: pageSize, offset: pick(offsets) };
  const started = Date.now();
  const res = http.post(apiUrl, JSON.stringify({ query, variables }), {
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
  });
  pageDuration.add(Date.now() - started);
  check(res, {
    'status 200': (r) => r.status === 200,
    'no graphql errors': (r) => !String(r.body).includes('"errors"'),
  });
}

export function handleSummary(data) {
  const m = data.metrics.openmap_telemetry_fleet_ms;
  const result = {
    name: 'telemetry-fleet',
    p95Ms: m ? m.values['p(95)'] : null,
    medianMs: m ? m.values.med : null,
    budgetMs,
    vus: Number(__ENV.VUS || '8'),
    generatedAt: new Date().toISOString(),
  };
  return {
    'results/telemetry-fleet.json': JSON.stringify(result, null, 2),
    stdout: JSON.stringify(result) + '\n',
  };
}
