// T-188 REQ-CMDB-032 (ADR-036) — the certificate watcher against the real Postgres: a certificate expiring in five days
// behind two TLS listeners raises one 7-day alert with its outbox event, an expired one raises threshold 0, one far out
// raises nothing, and a second check raises nothing more.
import { randomUUID } from 'node:crypto';
import { createPrismaClient } from '@openmap/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CERTIFICATE_EXPIRING, checkCertificates } from './certificates.js';

const prisma = createPrismaClient();
const tenantId = randomUUID();
const organizationId = randomUUID();
const now = new Date();
const DAY_MS = 86_400_000;

async function storeCi(type: 'certificate' | 'listening_service', name: string, attributes: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  await prisma.ci.create({
    data: {
      id,
      tenantId,
      type,
      identity: { name },
      identityKey: name,
      name,
      displayName: name,
      code: 'T-' + id.slice(0, 8).toUpperCase(),
      layer: 'network_security',
      lifecycle: 'managed',
      attributes: attributes as object,
      tags: [],
      sourceCollectorId: 'certificate',
      sourceNodeId: 'test',
      sourceRunId: randomUUID(),
      sourceConfidence: 0.9,
      observedAt: now,
      validFrom: now,
      checksum: 'c'.repeat(64),
    },
  });
  return id;
}

describe('certificate expiry watcher (integration)', () => {
  beforeAll(async () => {
    await prisma.organization.create({ data: { id: organizationId, name: 'Certificate org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: false } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'certificates', slug: 'certificates-' + tenantId.slice(0, 8) } });
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  it('raises each threshold once with its outbox event', async () => {
    const soon = await storeCi('certificate', 'api.bank.example', { subject: 'CN=api.bank.example', notAfter: new Date(now.getTime() + 5 * DAY_MS + DAY_MS / 2).toISOString() });
    const gone = await storeCi('certificate', 'old.bank.example', { subject: 'CN=old.bank.example', notAfter: new Date(now.getTime() - 2 * DAY_MS).toISOString() });
    await storeCi('certificate', 'far.bank.example', { subject: 'CN=far.bank.example', notAfter: new Date(now.getTime() + 300 * DAY_MS).toISOString() });
    for (const port of ['443', '8443']) {
      const listener = await storeCi('listening_service', 'tcp/' + port + ' tls', { port: Number(port), tls: true });
      await prisma.relationship.create({
        data: { tenantId, type: 'secured_by', fromCiId: listener, toCiId: soon, attributes: {}, sourceCollectorId: 'certificate', sourceNodeId: 'test', sourceRunId: randomUUID(), sourceConfidence: 0.9, observedAt: now, validFrom: now },
      });
    }

    await checkCertificates(prisma, now);
    const alerts = await prisma.certificateAlert.findMany({ where: { tenantId }, orderBy: { thresholdDays: 'asc' } });
    expect(alerts.map((a) => [a.ciId, a.thresholdDays, a.daysLeft])).toEqual([
      [gone, 0, -2],
      [soon, 7, 5],
    ]);
    const events = await prisma.outboxEvent.findMany({ where: { tenantId, type: CERTIFICATE_EXPIRING } });
    expect(events).toHaveLength(2);
    const soonEvent = events.find((e) => e.subject === soon);
    expect((soonEvent?.envelope as { data: Record<string, unknown> } | undefined)?.data).toMatchObject({
      ciId: soon,
      subject: 'CN=api.bank.example',
      thresholdDays: 7,
      daysLeft: 5,
      expired: false,
      endpoints: 2,
    });
    expect(alerts.find((a) => a.ciId === soon)?.eventId).toBe(soonEvent?.eventId);

    await checkCertificates(prisma, now);
    expect(await prisma.certificateAlert.count({ where: { tenantId } })).toBe(2);
    expect(await prisma.outboxEvent.count({ where: { tenantId, type: CERTIFICATE_EXPIRING } })).toBe(2);
  });
});
