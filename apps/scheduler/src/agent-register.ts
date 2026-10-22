// REQ-DISC-004 — registers a host agent against a Discovery Node and prints its one-time enrolment token. The
// token is shown once; only its SHA-256 digest is stored, and the agent exchanges it for an mTLS certificate
// through its Node (POST /v1/agents/enrol on the Node, forwarded to the scheduler).
// Usage: pnpm --filter @openmap/scheduler agent:register -- --node <nodeId> --agent <agentId>
import { randomBytes } from 'node:crypto';
import { loadEnv } from '@openmap/config';
import { PKI } from '@openmap/constants';
import { createPrismaClient } from '@openmap/db';
import { tokenDigest } from './server/app.js';

interface Args {
  node: string;
  agent: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { node: '', agent: '' };
  for (let i = 0; i < argv.length; i++) {
    const next = (): string => argv[++i] ?? '';
    switch (argv[i]) {
      case '--node':
        out.node = next();
        break;
      case '--agent':
        out.agent = next();
        break;
      default:
        break;
    }
  }
  if (!out.node || !out.agent) throw new Error('usage: agent-register --node <nodeId> --agent <agentId>');
  return out;
}

async function main(): Promise<void> {
  const [, , ...argv] = process.argv;
  const args = parseArgs(argv);
  const env = loadEnv();
  const prisma = createPrismaClient(env);
  const node = await prisma.discoveryNode.findUnique({ where: { id: args.node } });
  if (!node) throw new Error('unknown node ' + args.node);
  const token = randomBytes(PKI.enrolTokenBytes).toString('base64url');
  const existing = await prisma.agent.findUnique({ where: { tenantId_agentId: { tenantId: node.tenantId, agentId: args.agent } } });
  if (existing) {
    // Re-registration rotates the token and returns the agent to pending so it can enrol again (new host, new key).
    await prisma.agent.update({ where: { id: existing.id }, data: { nodeId: node.id, status: 'pending', enrolTokenDigest: tokenDigest(token), enrolledAt: null, certificateSerial: null, certificateFingerprint: null, certificateExpiresAt: null } });
  } else {
    await prisma.agent.create({ data: { tenantId: node.tenantId, nodeId: node.id, agentId: args.agent, status: 'pending', enrolTokenDigest: tokenDigest(token) } });
  }
  console.log(JSON.stringify({ msg: 'agent registered', agentId: args.agent, nodeId: node.id, tenantId: node.tenantId, enrolToken: token, note: 'shown once; set OPENMAP_ENROL_TOKEN on the host and run openmap-agent enrol' }));
  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
