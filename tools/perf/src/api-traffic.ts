// REQ-QA-004 REQ-PERF-005 — sends signed-in GraphQL reads to the running API for a while, so Prometheus holds the
// request rate and GraphQL latency a dev stack accumulates from use. The platform health suite (T-615) reads both over
// a day; on a fresh CI stack nothing else has used the API. The traffic runs long enough for the OpenTelemetry SDK's
// periodic metric export (one minute by default) to reach the collector twice and for Prometheus to scrape it.
//   pnpm --filter @openmap/perf api-traffic [--tenant <id>] [--seconds N]
import { loadEnv } from '@openmap/config';
import { TIME } from '@openmap/constants';
import { createPrismaClient } from '@openmap/db';
import { tokenFor } from './keycloak.js';

const TRAFFIC = {
  /** Two OpenTelemetry export intervals and a half, so a rate has two samples with an increase between them. */
  defaultSeconds: 150,
  /** One read every few seconds: a handful of samples per Prometheus scrape interval. */
  everyMs: 5 * TIME.msPerSecond,
} as const;

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
  const until = Date.now() + Number(flag('seconds') ?? TRAFFIC.defaultSeconds) * TIME.msPerSecond;
  let sent = 0;
  while (Date.now() < until) {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ query: '{ ciTags(limit: 5) { tag count } }' }),
    });
    const body = (await res.json()) as { data?: unknown; errors?: unknown };
    if (body.data === undefined || body.data === null) throw new Error('GraphQL read failed: ' + JSON.stringify(body.errors));
    sent += 1;
    await new Promise((r) => setTimeout(r, TRAFFIC.everyMs));
  }
  console.log(JSON.stringify({ msg: 'api traffic', tenantId, sent }));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
