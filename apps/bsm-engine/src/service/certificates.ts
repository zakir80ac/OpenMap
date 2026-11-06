// REQ-CMDB-032 (ADR-036) — the certificate expiry watcher. Every CERTIFICATES.checkEveryMs it reads the current
// certificate CIs of every tenant, works out the threshold each has reached from its notAfter (60, 30, 14, 7 and 1
// days, then 0 once expired) and raises `openmap.certificate.expiring` once per certificate, expiry date and threshold:
// the alert row and its outbox event are written in one transaction, and the unique key on the alert keeps a second
// watcher (or a restart) from raising it twice. Integrations and notifications take the event from the outbox.
import { CERTIFICATES } from '@openmap/constants';
import { CERTIFICATE_ATTRIBUTES, certificateDaysLeft, certificateThreshold, type CertificateExpiring } from '@openmap/contracts';
import { Prisma, type PrismaClient } from '@openmap/db';
import { envelope } from './engine.js';

export const CERTIFICATE_EXPIRING = 'openmap.certificate.expiring' as const;
const SECURED_BY = 'secured_by';

export interface CertificateCandidate {
  tenantId: string;
  ciId: string;
  subject: string;
  notAfter: string;
}

export interface PlannedAlert extends CertificateExpiring {
  tenantId: string;
}

/** The alerts due for these certificates at `now`, given the (ciId, notAfter, threshold) keys already raised. */
export function dueAlerts(
  candidates: readonly CertificateCandidate[],
  raised: ReadonlySet<string>,
  endpoints: ReadonlyMap<string, number>,
  now: Date,
  thresholds: readonly number[] = CERTIFICATES.alertThresholdsDays,
): PlannedAlert[] {
  const out: PlannedAlert[] = [];
  for (const c of candidates) {
    if (Number.isNaN(Date.parse(c.notAfter))) continue;
    const daysLeft = certificateDaysLeft(c.notAfter, now);
    const thresholdDays = certificateThreshold(daysLeft, thresholds);
    if (thresholdDays === null) continue;
    const notAfter = new Date(c.notAfter).toISOString();
    if (raised.has(alertKey(c.ciId, notAfter, thresholdDays))) continue;
    out.push({
      tenantId: c.tenantId,
      ciId: c.ciId,
      subject: c.subject,
      notAfter,
      daysLeft,
      thresholdDays,
      expired: daysLeft < 0,
      endpoints: endpoints.get(c.ciId) ?? 0,
    });
  }
  return out;
}

export function alertKey(ciId: string, notAfter: string, thresholdDays: number): string {
  return ciId + '|' + new Date(notAfter).toISOString() + '|' + String(thresholdDays);
}

export interface CertificateCheckReport {
  certificates: number;
  raised: number;
}

export async function checkCertificates(prisma: PrismaClient, now: Date): Promise<CertificateCheckReport> {
  const candidates = await prisma.$queryRaw<CertificateCandidate[]>(Prisma.sql`
    SELECT "tenantId", id AS "ciId", COALESCE(attributes->>${CERTIFICATE_ATTRIBUTES.subject}, name) AS subject,
      attributes->>${CERTIFICATE_ATTRIBUTES.notAfter} AS "notAfter"
    FROM cis
    WHERE type = 'certificate'::"CiType" AND "validTo" IS NULL AND attributes ? ${CERTIFICATE_ATTRIBUTES.notAfter}`);
  if (candidates.length === 0) return { certificates: 0, raised: 0 };
  const ids = candidates.map((c) => c.ciId);
  const [existing, links] = await Promise.all([
    prisma.certificateAlert.findMany({ where: { ciId: { in: ids } }, select: { ciId: true, notAfter: true, thresholdDays: true } }),
    prisma.relationship.groupBy({ by: ['toCiId'], where: { toCiId: { in: ids }, type: SECURED_BY, validTo: null }, _count: { _all: true } }),
  ]);
  const raised = new Set(existing.map((a) => alertKey(a.ciId, a.notAfter.toISOString(), a.thresholdDays)));
  const endpoints = new Map(links.map((l) => [l.toCiId, l._count._all]));
  const due = dueAlerts(candidates, raised, endpoints, now);
  let count = 0;
  for (const alert of due) {
    const { tenantId, ...data } = alert;
    const e = envelope(tenantId, CERTIFICATE_EXPIRING, alert.ciId, { ...data }, now.toISOString());
    const created = await prisma.$transaction(async (tx) => {
      const inserted = await tx.certificateAlert.createMany({
        data: [{ tenantId, ciId: alert.ciId, notAfter: new Date(alert.notAfter), thresholdDays: alert.thresholdDays, daysLeft: alert.daysLeft, eventId: e.id }],
        skipDuplicates: true,
      });
      if (inserted.count === 0) return false;
      await tx.outboxEvent.create({
        data: { eventId: e.id, tenantId, type: e.type, subject: e.subject, envelope: e as unknown as Prisma.InputJsonValue, pending: ['clickhouse', 'websocket'] },
      });
      return true;
    });
    if (created) count += 1;
  }
  return { certificates: candidates.length, raised: count };
}
