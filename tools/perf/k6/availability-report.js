// REQ-BSM-008 — k6 budget test: the yearly availability roll-up of every business service, p95 under
// PERF_BUDGETS.availabilityReportP95Ms (1000 ms for 300 services). Run with environment: API_URL (GraphQL endpoint),
// TOKEN (bearer), optional GRANULARITY (year|quarter|month), PERIODS, VUS, DURATION, BUDGET_MS.
// k6 is AGPL and runs as a separate process (ADR-001); this script carries no OpenMap code.
import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const budgetMs = Number(__ENV.BUDGET_MS || '1000');
const apiUrl = __ENV.API_URL;
const token = __ENV.TOKEN;
const granularity = __ENV.GRANULARITY || 'year';
const periods = Number(__ENV.PERIODS || '3');
const reportDuration = new Trend('openmap_availability_report_ms', true);

export const options = {
  scenarios: {
    report: { executor: 'constant-vus', vus: Number(__ENV.VUS || '4'), duration: __ENV.DURATION || '30s' },
  },
  thresholds: {
    openmap_availability_report_ms: ['p(95)<' + budgetMs],
    http_req_failed: ['rate<0.01'],
  },
};

const query = `query Report($granularity: AvailabilityGranularity!, $periods: Int) { availabilityReport(granularity: $granularity, periods: $periods) { service { id } sla { id } periods { year quarter month availabilityPercent downtimeMinutes targetPercent met } } }`;

export default function () {
  if (!apiUrl || !token) throw new Error('API_URL and TOKEN are required');
  const started = Date.now();
  const res = http.post(apiUrl, JSON.stringify({ query, variables: { granularity, periods } }), {
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
  });
  reportDuration.add(Date.now() - started);
  check(res, {
    'status 200': (r) => r.status === 200,
    'no graphql errors': (r) => !String(r.body).includes('"errors"'),
  });
}

// k6 v2 consolidates `options` in handleSummary; the VU count is read from the environment it came from.
export function handleSummary(data) {
  const p95 = data.metrics.openmap_availability_report_ms
    ? data.metrics.openmap_availability_report_ms.values['p(95)']
    : null;
  const result = {
    name: 'availability-report',
    p95Ms: p95,
    budgetMs,
    granularity,
    periods,
    vus: Number(__ENV.VUS || '4'),
    generatedAt: new Date().toISOString(),
  };
  return {
    'results/availability-report.json': JSON.stringify(result, null, 2),
    stdout: JSON.stringify(result) + '\n',
  };
}
