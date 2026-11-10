// REQ-INT-017 (ADR-075) — plans and schedules backup-awareness jobs for a tenant's backup servers, with the CMDB
// inventory the collector matches vendor objects against.
// Usage: pnpm --filter @openmap/scheduler backup:plan -- --tenant <uuid> --node <id>
//          --server <vendor>=<url> --credential-ref <vendor>=<bao path> [--server ... --credential-ref ...]
//          [--option key=value]... [--dry-run]
// Vendors: veeam, commvault, rubrik. Simulated mode points the servers at tools/simulator.
import { loadEnv } from '@openmap/config';
import { BACKUP_AWARENESS } from '@openmap/constants';
import type { BackupVendor, CiType } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { planBackupJobs, vendorPair, type BackupServer } from './core/backup.js';
import { createJobStore } from './server/jobs.js';

interface Args {
  tenant: string;
  node: string;
  urls: Map<BackupVendor, string>;
  refs: Map<BackupVendor, string>;
  options: Record<string, unknown>;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { tenant: '', node: '', urls: new Map(), refs: new Map(), options: {}, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const next = (): string => argv[++i] ?? '';
    if (arg === '--tenant') out.tenant = next();
    else if (arg === '--node') out.node = next();
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--server') {
      const p = vendorPair(next());
      out.urls.set(p.vendor, p.value);
    } else if (arg === '--credential-ref') {
      const p = vendorPair(next());
      out.refs.set(p.vendor, p.value);
    } else if (arg === '--option') {
      const [k, ...rest] = next().split('=');
      const v = rest.join('=');
      if (k) out.options[k] = v === 'true' ? true : v === 'false' ? false : v;
    }
  }
  if (!out.tenant || !out.node || out.urls.size === 0)
    throw new Error('usage: backup-plan --tenant <uuid> --node <id> --server <vendor>=<url> --credential-ref <vendor>=<path> [--option k=v] [--dry-run]');
  return out;
}

async function main(): Promise<void> {
  const [, , ...argv] = process.argv;
  const args = parseArgs(argv);
  const servers: BackupServer[] = [];
  for (const [vendor, url] of args.urls) {
    const credentialRef = args.refs.get(vendor);
    if (credentialRef === undefined) throw new Error('no --credential-ref for ' + vendor);
    servers.push({ vendor, url, credentialRef });
  }
  const env = loadEnv();
  const prisma = createPrismaClient(env);
  const rows = await prisma.ci.findMany({
    where: { tenantId: args.tenant, validTo: null, type: { in: [...BACKUP_AWARENESS.inventoryTypes] as CiType[] } },
    select: { type: true, name: true, identity: true, attributes: true },
  });
  const jobs = planBackupJobs({
    tenantId: args.tenant,
    nodeId: args.node,
    servers,
    rows: rows.map((r) => ({ type: r.type, name: r.name, identity: r.identity as Record<string, unknown>, attributes: r.attributes as Record<string, unknown> })),
    options: args.options,
    now: new Date().toISOString(),
  });
  const scheduled = args.dryRun ? 0 : await createJobStore(prisma).schedule(jobs);
  console.log(JSON.stringify({ msg: 'backup awareness planned', jobs: jobs.length, scheduled, inventory: rows.length }));
  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
