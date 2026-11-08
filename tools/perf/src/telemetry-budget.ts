// REQ-UI-027 — runs the Health and telemetry table's k6 budget against a loaded estate, end to end:
// - picks the tenant with the most CIs (or --tenant);
// - takes a load-test user's token for it (keycloak.ts);
// - warms the tenant's fleet snapshot with one request, so the budget measures the pages a person scrolls, not the
//   first build (TELEMETRY.snapshotMs keeps it fresh in the background after that);
// - runs k6/telemetry-fleet.js; its summary writes results/telemetry-fleet.json, which `pnpm guard` checks against
//   PERF_BUDGETS.screenInteractionP95Ms.
// Usage: pnpm --filter @openmap/perf telemetry-budget [--tenant <id>] [--vus N] [--duration 60s]
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '@openmap/config';
import { PERF_BUDGETS, TELEMETRY } from '@openmap/constants';
import { createPrismaClient } from '@openmap/db';
import { tokenFor } from './keycloak.js';

const env = loadEnv();
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main(): Promise<void> {
  const prisma = createPrismaClient(env);
  const tenantId =
    flag('tenant') ??
    (await prisma.ci.groupBy({ by: ['tenantId'], where: { validTo: null }, _count: { _all: true }, orderBy: { _count: { tenantId: 'desc' } }, take: 1 }))[0]?.tenantId;
  await prisma.$disconnect();
  if (tenantId === undefined) throw new Error('no loaded estate: replay one first (tools/perf/README.md)');
  const token = await tokenFor(env, tenantId);
  const apiUrl = env.PUBLIC_API_URL.replace(/\/+$/, '') + '/graphql';
  const warmed = Date.now();
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ query: '{ telemetryFleet(first: 1) { total } }' }),
  });
  const warm = (await res.json()) as { data?: { telemetryFleet: { total: number } }; errors?: unknown };
  if (warm.data === undefined) throw new Error('warm-up failed: ' + JSON.stringify(warm.errors));
  console.log(JSON.stringify({ msg: 'telemetry budget', tenantId, rows: warm.data.telemetryFleet.total, warmMs: Date.now() - warmed, budgetMs: PERF_BUDGETS.screenInteractionP95Ms }));
  const k6 = spawnSync('k6', ['run', '--quiet', 'k6/telemetry-fleet.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: 'inherit',
    env: {
      ...process.env,
      API_URL: apiUrl,
      TOKEN: token,
      BUDGET_MS: String(PERF_BUDGETS.screenInteractionP95Ms),
      PAGE_SIZE: String(TELEMETRY.defaultPageSize),
      ...(flag('vus') === undefined ? {} : { VUS: flag('vus') }),
      ...(flag('duration') === undefined ? {} : { DURATION: flag('duration') }),
    },
  });
  process.exit(k6.status ?? 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
