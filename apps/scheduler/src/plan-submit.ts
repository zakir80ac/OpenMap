// REQ-QA-005 REQ-DISC-029 (ADR-042) — submits a job plan file to one Node: every entry becomes a collector job; an
// entry that carries its credential (simulated mode's per-run secrets) has it written to OpenBao first under
// `<prefix>/<simulator>/<run>`, and the job references that path like any stored credential.
// Usage: pnpm --filter @openmap/scheduler plan:submit -- --tenant <uuid> --node <id> --plan <file> [--prefix simulated]
//          [--only <simulator,...>] [--dry-run]
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadEnv, type Env } from '@openmap/config';
import { CONTRACT_VERSIONS, CREDENTIAL_REF_PATTERN, DISCOVERY } from '@openmap/constants';
import { collectorJobSchema, credentialTypeSchema, targetSchema, type CollectorJob } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { z } from 'zod';
import { createJobStore } from './server/jobs.js';

const planEntrySchema = z.object({
  simulator: z.string().min(1),
  run: z.string(),
  collector: z.string().min(1),
  targets: z.array(targetSchema).min(1),
  options: z.record(z.string(), z.unknown()).default({}),
  credentialType: z.string().default('none'),
  credential: z.object({ type: z.string().min(1), fields: z.record(z.string(), z.string()) }).nullable().default(null),
  provenance: z.string().optional(),
});
type PlanEntry = z.infer<typeof planEntrySchema>;

interface Args {
  tenant: string;
  node: string;
  plan: string;
  prefix: string;
  only: Set<string>;
  dryRun: boolean;
}

const DEFAULT_PREFIX = 'simulated';

function parseArgs(argv: string[]): Args {
  const out: Args = { tenant: '', node: '', plan: '', prefix: DEFAULT_PREFIX, only: new Set(), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const next = (): string => argv[++i] ?? '';
    switch (argv[i]) {
      case '--tenant':
        out.tenant = next();
        break;
      case '--node':
        out.node = next();
        break;
      case '--plan':
        out.plan = next();
        break;
      case '--prefix':
        out.prefix = next();
        break;
      case '--only':
        for (const s of next().split(',')) if (s.trim() !== '') out.only.add(s.trim());
        break;
      case '--dry-run':
        out.dryRun = true;
        break;
      default:
        break;
    }
  }
  if (!out.tenant || !out.node || !out.plan) throw new Error('usage: plan-submit --tenant <uuid> --node <id> --plan <file> [--prefix p] [--only a,b] [--dry-run]');
  return out;
}

/** The vault path of an entry's credential: path segments limited to the characters references allow. */
export function credentialPath(prefix: string, entry: Pick<PlanEntry, 'simulator' | 'run'>): string {
  const clean = (s: string): string =>
    s
      .replace(/[^A-Za-z0-9_.-]+/gu, '-')
      .replace(/\.\.+/gu, '.')
      .replace(/^[-.]+|[-.]+$/gu, '') || 'default';
  const path = [clean(prefix), clean(entry.simulator), clean(entry.run)].join('/');
  if (!CREDENTIAL_REF_PATTERN.test(path)) throw new Error('credential path has unexpected characters: ' + path);
  return path;
}

async function storeCredential(env: Env, path: string, credential: NonNullable<PlanEntry['credential']>): Promise<void> {
  const base = env.OPENBAO_ADDR.endsWith('/') ? env.OPENBAO_ADDR : env.OPENBAO_ADDR + '/';
  const res = await fetch(new URL('v1/' + env.OPENBAO_MOUNT + '/data/' + path, base), {
    method: 'POST',
    headers: { 'X-Vault-Token': env.OPENBAO_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ data: { type: credential.type, ...credential.fields } }),
  });
  if (!res.ok) throw new Error('OpenBao returned ' + String(res.status) + ' writing ' + path);
}

export function jobFor(entry: PlanEntry, tenantId: string, nodeId: string, credentialRef: string | null, now: string): CollectorJob {
  return collectorJobSchema.parse({
    jobId: randomUUID(),
    tenantId,
    collectorId: entry.collector,
    nodeId,
    targets: entry.targets,
    credentialRef,
    credentialType: credentialTypeSchema.parse(credentialRef === null ? 'none' : entry.credentialType),
    timeoutMs: DISCOVERY.defaultJobTimeoutMs,
    rateLimit: { concurrency: DISCOVERY.defaultConcurrency, requestsPerSecond: DISCOVERY.defaultRequestsPerSecond },
    options: entry.options,
    scheduledAt: now,
    contractVersion: CONTRACT_VERSIONS.collector,
  });
}

async function main(): Promise<void> {
  const [, , ...argv] = process.argv;
  const args = parseArgs(argv);
  const env = loadEnv();
  const entries = z.array(planEntrySchema).parse(JSON.parse(await readFile(args.plan, 'utf8')) as unknown);
  const chosen = entries.filter((e) => args.only.size === 0 || args.only.has(e.simulator));
  const now = new Date().toISOString();
  const jobs: CollectorJob[] = [];
  for (const entry of chosen) {
    let ref: string | null = null;
    if (entry.credential !== null) {
      ref = credentialPath(args.prefix, entry);
      if (!args.dryRun) await storeCredential(env, ref, entry.credential);
    }
    jobs.push(jobFor(entry, args.tenant, args.node, ref, now));
  }
  const prisma = createPrismaClient(env);
  const scheduled = args.dryRun ? 0 : await createJobStore(prisma).schedule(jobs);
  console.log(JSON.stringify({ msg: 'plan submitted', entries: chosen.length, scheduled, jobs: jobs.map((j) => ({ jobId: j.jobId, collectorId: j.collectorId, credentialRef: j.credentialRef })) }));
  await prisma.$disconnect();
}

if (process.argv[1]?.endsWith('plan-submit.ts') === true || process.argv[1]?.endsWith('plan-submit.js') === true) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
