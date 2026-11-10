// REQ-SEC-011 (ADR-067 step 4) — encrypts the personal data written before field encryption: vendor contacts (name,
// email, phone), asset custodians and the custodian values in asset audits. Values already stored as Transit
// ciphertext are left alone, so the command can run again at any time; it reads and writes in batches of
// VAULT.transitBatch. Sensitive custom fields need no backfill: whether a field is sensitive is fixed when it is
// created, so its values were encrypted from the first one.
// Usage: node dist/encrypt-fields.js [--tenant <id>]
import { loadEnv } from '@openmap/config';
import { VAULT } from '@openmap/constants';
import { createPrismaClient, type PrismaClient } from '@openmap/db';
import { withSpan } from '@openmap/telemetry';
import { createFieldCipher, createVaultTokenProvider, type FieldCipher } from '@openmap/vault';

const TRACER = 'openmap-reconciler';
const CUSTODIAN = 'custodian';

export interface SealReport {
  vendorContacts: number;
  custodians: number;
  audits: number;
}

const plain = { not: { startsWith: VAULT.ciphertextPrefix } } as const;

/** Encrypts every plaintext value of the tenant (or of every tenant with `tenantId` null). */
export async function sealPlaintextFields(prisma: PrismaClient, cipher: FieldCipher, tenantId: string | null): Promise<SealReport> {
  return withSpan(TRACER, 'reconciler.encrypt_fields', { 'openmap.tenant_id': tenantId ?? 'all' }, async () => {
    const scope = tenantId === null ? {} : { tenantId };
    const report: SealReport = { vendorContacts: 0, custodians: 0, audits: 0 };

    for (;;) {
      const rows = await prisma.vendorContact.findMany({
        where: { ...scope, OR: [{ name: plain }, { email: plain }, { phone: plain }] },
        select: { id: true, name: true, email: true, phone: true },
        take: VAULT.transitBatch,
      });
      if (rows.length === 0) break;
      const n = rows.length;
      const sealed = await cipher.encrypt([...rows.map((r) => r.name), ...rows.map((r) => r.email), ...rows.map((r) => r.phone)]);
      await prisma.$transaction(
        rows.map((r, i) =>
          prisma.vendorContact.update({
            where: { id: r.id },
            data: { name: sealed[i] ?? r.name, email: sealed[n + i] ?? null, phone: sealed[n + n + i] ?? null },
          }),
        ),
      );
      report.vendorContacts += n;
    }

    for (;;) {
      const rows = await prisma.assetRecord.findMany({
        where: { ...scope, custodian: plain },
        select: { id: true, custodian: true },
        take: VAULT.transitBatch,
      });
      if (rows.length === 0) break;
      const sealed = await cipher.encrypt(rows.map((r) => r.custodian));
      await prisma.$transaction(rows.map((r, i) => prisma.assetRecord.update({ where: { id: r.id }, data: { custodian: sealed[i] ?? null } })));
      report.custodians += rows.length;
    }

    for (;;) {
      const rows = await prisma.assetAudit.findMany({
        where: { ...scope, field: CUSTODIAN, OR: [{ fromValue: plain }, { toValue: plain }] },
        select: { id: true, fromValue: true, toValue: true },
        take: VAULT.transitBatch,
      });
      if (rows.length === 0) break;
      const n = rows.length;
      const sealed = await cipher.encrypt([...rows.map((r) => r.fromValue), ...rows.map((r) => r.toValue)]);
      await prisma.$transaction(
        rows.map((r, i) => prisma.assetAudit.update({ where: { id: r.id }, data: { fromValue: sealed[i] ?? null, toValue: sealed[n + i] ?? null } })),
      );
      report.audits += n;
    }
    return report;
  });
}

async function main(): Promise<void> {
  const [, , ...argv] = process.argv;
  const at = argv.indexOf('--tenant');
  const tenantId = at >= 0 ? (argv[at + 1] ?? null) : null;
  const env = loadEnv();
  const prisma = createPrismaClient(env);
  const cipher = createFieldCipher(env, createVaultTokenProvider(env));
  const started = Date.now();
  const report = await sealPlaintextFields(prisma, cipher, tenantId);
  console.log(JSON.stringify({ msg: 'fields encrypted', tenantId, ...report, ms: Date.now() - started }));
  await prisma.$disconnect();
}

if (process.argv[1]?.endsWith('encrypt-fields.js') === true || process.argv[1]?.endsWith('encrypt-fields.ts') === true) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
