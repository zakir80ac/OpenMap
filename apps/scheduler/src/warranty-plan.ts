// REQ-CMDB-024 (ADR-043) — plans and schedules warranty and EoX lookups for a tenant's hardware from the CMDB.
// Usage: pnpm --filter @openmap/scheduler warranty:plan -- --tenant <uuid> --node <id>
//          [--dell-credential-ref <bao path>] [--lenovo-credential-ref <path>] [--cisco-credential-ref <path>]
//          [--option key=value]... [--dry-run]
// Endpoints come from WARRANTY_*_URL (packages/config); simulated mode points them at tools/simulator.
import { loadEnv } from '@openmap/config';
import { WARRANTY } from '@openmap/constants';
import type { CiType } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { planWarrantyJobs, WARRANTY_VENDORS, type HardwareRow, type WarrantyVendor } from './core/warranty.js';
import { createJobStore } from './server/jobs.js';

interface Args {
  tenant: string;
  node: string;
  refs: Partial<Record<WarrantyVendor, string>>;
  options: Record<string, unknown>;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { tenant: '', node: '', refs: {}, options: {}, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const next = (): string => argv[++i] ?? '';
    const vendor = WARRANTY_VENDORS.find((v) => arg === '--' + v + '-credential-ref');
    if (vendor !== undefined) out.refs[vendor] = next();
    else if (arg === '--tenant') out.tenant = next();
    else if (arg === '--node') out.node = next();
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--option') {
      const [k, ...rest] = next().split('=');
      const v = rest.join('=');
      if (k) out.options[k] = v === 'true' ? true : v === 'false' ? false : v;
    }
  }
  if (!out.tenant || !out.node) throw new Error('usage: warranty-plan --tenant <uuid> --node <id> [--<vendor>-credential-ref <path>]... [--option k=v] [--dry-run]');
  return out;
}

function text(record: unknown, key: string): string | null {
  if (record === null || typeof record !== 'object') return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

async function main(): Promise<void> {
  const [, , ...argv] = process.argv;
  const args = parseArgs(argv);
  const env = loadEnv();
  const prisma = createPrismaClient(env);
  const cis = await prisma.ci.findMany({
    where: { tenantId: args.tenant, validTo: null, type: { in: [...WARRANTY.ciTypes] as CiType[] } },
    select: { type: true, name: true, identity: true, attributes: true },
  });
  const rows: HardwareRow[] = cis.map((c) => ({
    ciType: c.type,
    name: c.name,
    serialNumber: text(c.identity, 'serialNumber') ?? text(c.attributes, 'serialNumber'),
    manufacturer: text(c.attributes, 'manufacturer') ?? text(c.attributes, 'vendor'),
  }));
  const plan = planWarrantyJobs({
    tenantId: args.tenant,
    nodeId: args.node,
    rows,
    endpoints: {
      dell: { apiUrl: env.WARRANTY_DELL_API_URL, tokenUrl: env.WARRANTY_DELL_TOKEN_URL },
      lenovo: { apiUrl: env.WARRANTY_LENOVO_API_URL },
      cisco: { apiUrl: env.WARRANTY_CISCO_API_URL, tokenUrl: env.WARRANTY_CISCO_TOKEN_URL },
    },
    credentialRefs: args.refs,
    options: args.options,
    now: new Date().toISOString(),
  });
  const scheduled = args.dryRun ? 0 : await createJobStore(prisma).schedule(plan.jobs);
  console.log(JSON.stringify({ msg: 'warranty lookups planned', jobs: plan.jobs.length, scheduled, planned: plan.planned, withoutCredential: plan.withoutCredential, unsupported: plan.unsupported }));
  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
