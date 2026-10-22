// REQ-DISC-029 — submits one collector job to a Node directly through the job store (the console's
// sweep planner does this at scale; this is the operator's and the end-to-end test's entry point).
// Usage: pnpm --filter @openmap/scheduler job:submit -- --tenant <uuid> --node <id> --collector <id> --target <value> [--kind host] [--credential-ref <bao path>] [--credential-type none] [--option key=value]...
import { randomUUID } from 'node:crypto';
import { loadEnv } from '@openmap/config';
import { CONTRACT_VERSIONS, DISCOVERY } from '@openmap/constants';
import { collectorJobSchema, credentialTypeSchema, targetSchema, type CollectorJob } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { createJobStore } from './server/jobs.js';

interface Args {
  tenant: string;
  node: string;
  collector: string;
  targets: string[];
  kind: string;
  credentialRef: string | null;
  credentialType: string;
  options: Record<string, unknown>;
}

function coerce(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/u.test(value)) return Number(value);
  if (value.startsWith('[') || value.startsWith('{')) return JSON.parse(value) as unknown;
  return value;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { tenant: '', node: '', collector: '', targets: [], kind: 'host', credentialRef: null, credentialType: 'none', options: {} };
  for (let i = 0; i < argv.length; i++) {
    const next = (): string => argv[++i] ?? '';
    switch (argv[i]) {
      case '--tenant':
        out.tenant = next();
        break;
      case '--node':
        out.node = next();
        break;
      case '--collector':
        out.collector = next();
        break;
      case '--target':
        out.targets.push(next());
        break;
      case '--kind':
        out.kind = next();
        break;
      case '--credential-ref':
        out.credentialRef = next();
        break;
      case '--credential-type':
        out.credentialType = next();
        break;
      case '--option': {
        const [k, ...rest] = next().split('=');
        if (k) out.options[k] = coerce(rest.join('='));
        break;
      }
      default:
        break;
    }
  }
  if (!out.tenant || !out.node || !out.collector || out.targets.length === 0) {
    throw new Error('usage: job-submit --tenant <uuid> --node <id> --collector <id> --target <value> [--kind host] [--credential-ref <path>] [--credential-type none] [--option k=v]');
  }
  return out;
}

async function main(): Promise<void> {
  const [, , ...argv] = process.argv;
  const args = parseArgs(argv);
  const env = loadEnv();
  const prisma = createPrismaClient(env);
  const job: CollectorJob = collectorJobSchema.parse({
    jobId: randomUUID(),
    tenantId: args.tenant,
    collectorId: args.collector,
    nodeId: args.node,
    targets: args.targets.map((value) => targetSchema.parse({ kind: args.kind, value })),
    credentialRef: args.credentialRef,
    credentialType: credentialTypeSchema.parse(args.credentialType),
    timeoutMs: DISCOVERY.defaultJobTimeoutMs,
    rateLimit: { concurrency: DISCOVERY.defaultConcurrency, requestsPerSecond: DISCOVERY.defaultRequestsPerSecond },
    options: args.options,
    scheduledAt: new Date().toISOString(),
    contractVersion: CONTRACT_VERSIONS.collector,
  });
  const n = await createJobStore(prisma).schedule([job]);
  console.log(JSON.stringify({ msg: 'job scheduled', scheduled: n, jobId: job.jobId, collectorId: job.collectorId, nodeId: job.nodeId, targets: job.targets.length }));
  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
