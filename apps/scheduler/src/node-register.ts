// REQ-DISC-031 REQ-DISC-028 — registers a Discovery Node for a tenant and site and prints its
// one-time enrolment token. The token is shown once; only its SHA-256 digest is stored, and the
// Node exchanges it for an mTLS certificate at /v1/nodes/enrol.
// Usage: pnpm --filter @openmap/scheduler node:register -- --tenant <uuid> --site <code> --node <id> [--site-name <name>] [--kind datacenter]
import { randomBytes } from 'node:crypto';
import { loadEnv } from '@openmap/config';
import { PKI } from '@openmap/constants';
import { siteKindSchema } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { tokenDigest } from './server/app.js';

interface Args {
  tenant: string;
  site: string;
  node: string;
  siteName: string;
  kind: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { tenant: '', site: '', node: '', siteName: '', kind: 'datacenter' };
  for (let i = 0; i < argv.length; i++) {
    const next = (): string => argv[++i] ?? '';
    switch (argv[i]) {
      case '--tenant':
        out.tenant = next();
        break;
      case '--site':
        out.site = next();
        break;
      case '--node':
        out.node = next();
        break;
      case '--site-name':
        out.siteName = next();
        break;
      case '--kind':
        out.kind = next();
        break;
      default:
        break;
    }
  }
  if (!out.tenant || !out.site || !out.node) throw new Error('usage: node-register --tenant <uuid> --site <code> --node <id> [--site-name <name>] [--kind <site kind>]');
  return out;
}

async function main(): Promise<void> {
  const [, , ...argv] = process.argv;
  const args = parseArgs(argv);
  const env = loadEnv();
  const prisma = createPrismaClient(env);
  const tenant = await prisma.tenant.findUnique({ where: { id: args.tenant } });
  if (!tenant) throw new Error('tenant ' + args.tenant + ' does not exist');
  const kind = siteKindSchema.parse(args.kind);
  let site = await prisma.site.findFirst({ where: { organizationId: tenant.organizationId, code: args.site } });
  if (!site) {
    site = await prisma.site.create({
      data: { organizationId: tenant.organizationId, code: args.site, name: args.siteName || args.site, kind, address: '', city: '', countryCode: 'XX' },
    });
    console.log(JSON.stringify({ msg: 'site created', id: site.id, code: site.code }));
  }
  const token = randomBytes(PKI.serialBytes * 2).toString('hex');
  await prisma.discoveryNode.upsert({
    where: { id: args.node },
    update: { status: 'pending', enrolTokenDigest: tokenDigest(token), siteId: site.id, tenantId: tenant.id },
    create: { id: args.node, tenantId: tenant.id, siteId: site.id, status: 'pending', enrolTokenDigest: tokenDigest(token), collectorIds: [] },
  });
  console.log(JSON.stringify({ msg: 'node registered', nodeId: args.node, siteCode: site.code, tenantId: tenant.id, enrolToken: token, note: 'shown once; set OPENMAP_ENROL_TOKEN on the Node and run openmap-node enrol' }));
  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
