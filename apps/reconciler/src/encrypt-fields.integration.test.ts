// T-579 REQ-SEC-011 (ADR-067 step 4) — the field encryption backfill against the compose stack: a throwaway tenant gets
// vendor contacts, an asset with a custodian and a custodian audit written in plaintext (as before field encryption);
// the backfill turns every value into Transit ciphertext that decrypts to the original, leaves nulls alone, and a second
// run finds nothing to do. Needs OPENBAO_TOKEN (an operator token, e.g. from .local/openbao-root-token).
import { randomUUID } from 'node:crypto';
import { loadEnv } from '@openmap/config';
import { createPrismaClient } from '@openmap/db';
import { createFieldCipher, createVaultTokenProvider, isCiphertext } from '@openmap/vault';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sealPlaintextFields } from './encrypt-fields.js';

const env = loadEnv();
const prisma = createPrismaClient(env);
const cipher = createFieldCipher(env, createVaultTokenProvider(env));
const suffix = randomUUID().slice(0, 8);
const tenantId = randomUUID();
const organizationId = randomUUID();
const vendorCiId = randomUUID();
let assetId = '';

describe('field encryption backfill (integration)', () => {
  beforeAll(async () => {
    expect(env.OPENBAO_TOKEN, 'export OPENBAO_TOKEN with an operator token').toBeDefined();
    await prisma.organization.create({
      data: { id: organizationId, name: 'Seal org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: true },
    });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'Seal BU', slug: 'seal-' + suffix } });
    await prisma.vendorContact.createMany({
      data: [
        { tenantId, vendorCiId, name: 'Huda Al-Shehri', role: 'Account manager', email: 'huda@vendor.example', phone: '+966 12 345 6789' },
        { tenantId, vendorCiId, name: 'Omar Farouk', role: 'Engineer', email: null, phone: null },
      ],
    });
    const now = new Date();
    const asset = await prisma.assetRecord.create({
      data: {
        tenantId,
        layer: 'hardware',
        source: 'manual',
        assetTag: 'SEAL-' + suffix,
        stage: 'deployed',
        stageChangedAt: now,
        custodian: 'سارة الدوسري',
        depreciationMethod: 'none',
        usefulLifeMonths: 1,
        residualValueAmount: 0,
        residualValueCurrency: 'SAR',
        tags: [],
        customFields: {},
      },
    });
    assetId = asset.id;
    await prisma.assetAudit.create({
      data: { tenantId, assetId, actor: 'itest', at: now, field: 'custodian', fromValue: null, toValue: 'سارة الدوسري', note: null },
    });
  });

  afterAll(async () => {
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  it('encrypts what was written in plaintext, and a second run has nothing to do', async () => {
    const report = await sealPlaintextFields(prisma, cipher, tenantId);
    expect(report).toEqual({ vendorContacts: 2, custodians: 1, audits: 1 });

    const contacts = await prisma.vendorContact.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
    for (const c of contacts) expect(isCiphertext(c.name)).toBe(true);
    const omar = contacts.find((c) => c.email === null);
    expect(omar?.phone).toBeNull();
    const plain = await cipher.decrypt(contacts.flatMap((c) => [c.name, c.email, c.phone]));
    expect(plain).toEqual(expect.arrayContaining(['Huda Al-Shehri', 'huda@vendor.example', '+966 12 345 6789', 'Omar Farouk']));

    const asset = await prisma.assetRecord.findUnique({ where: { id: assetId } });
    expect(isCiphertext(asset?.custodian ?? '')).toBe(true);
    expect((await cipher.decrypt([asset?.custodian ?? null]))[0]).toBe('سارة الدوسري');
    const audit = await prisma.assetAudit.findFirst({ where: { assetId, field: 'custodian' } });
    expect(audit?.fromValue).toBeNull();
    expect((await cipher.decrypt([audit?.toValue ?? null]))[0]).toBe('سارة الدوسري');

    expect(await sealPlaintextFields(prisma, cipher, tenantId)).toEqual({ vendorContacts: 0, custodians: 0, audits: 0 });
  });
});
