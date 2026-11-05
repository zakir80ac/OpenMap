// REQ-DEP-002 (ADR-029) — dependency mapping on demand: runs the derivation pass for one tenant or for every tenant
// that has flows, prints the summary, and exits. The compose reconciler runs the same pass after the results that
// carry flows, addresses, listeners or components; this is for a replayed estate and for operators.
// Usage: pnpm --filter @openmap/reconciler adm [--tenant <uuid>]
import { loadEnv } from '@openmap/config';
import { createPrismaClient } from '@openmap/db';
import { runAdmPass } from './worker/adm.js';

function tenantArg(argv: readonly string[]): string | null {
  const i = argv.indexOf('--tenant');
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = createPrismaClient(env);
  try {
    const [, , ...argv] = process.argv;
    const only = tenantArg(argv);
    const tenants =
      only !== null
        ? [only]
        : (await prisma.relationship.findMany({ where: { type: 'communicates_with', validTo: null }, distinct: ['tenantId'], select: { tenantId: true } })).map((r) => r.tenantId);
    for (const tenantId of tenants) {
      const summary = await runAdmPass(prisma, tenantId);
      console.log(JSON.stringify({ msg: 'dependencies derived', ...summary }));
    }
    if (tenants.length === 0) console.log(JSON.stringify({ msg: 'no tenant has flows; nothing to derive' }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
