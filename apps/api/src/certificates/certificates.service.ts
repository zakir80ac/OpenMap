// REQ-CMDB-032 (ADR-036) — the certificate register over the certificate collector's CIs: each certificate with its
// subject, issuer, validity, days left from notAfter, key and signature weaknesses under CERTIFICATES' policy, the TLS
// endpoints it secures (listening_service —secured_by→ certificate) and the certificate that issued it (depends_on),
// plus the last expiry alert the BSM engine raised for it.
import { Inject, Injectable } from '@nestjs/common';
import { CERTIFICATES } from '@openmap/constants';
import { CERTIFICATE_ATTRIBUTES, certificateDaysLeft, certificateWeaknesses } from '@openmap/contracts';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord } from '../ci/ci.types.js';
import { booleanAttribute, isoAttribute, numberAttribute, stringArrayAttribute, stringAttribute } from '../common/validation.js';
import { PrismaService } from '../db/prisma.service.js';

export interface CertificateEndpointView {
  listener: CiRecord;
  host: string | null;
  port: number | null;
  serverName: string | null;
  tlsVersion: string | null;
}

export interface CertificateView {
  ci: CiRecord;
  subject: string;
  issuer: string | null;
  serial: string | null;
  notBefore: string | null;
  notAfter: string | null;
  daysLeft: number | null;
  expired: boolean;
  selfSigned: boolean;
  isCa: boolean;
  keyAlgorithm: string | null;
  keyBits: number | null;
  signatureAlgorithm: string | null;
  weaknesses: string[];
  dnsNames: string[];
  endpoints: CertificateEndpointView[];
  issuedById: string | null;
  lastAlertDays: number | null;
}

export interface CertificateFilter {
  text: string | null;
  expiringWithinDays: number | null;
  expired: boolean | null;
  selfSigned: boolean | null;
  weak: boolean | null;
  includeAuthorities: boolean;
}

const SECURED_BY = 'secured_by';
const DEPENDS_ON = 'depends_on';

export function toCertificateView(
  ci: CiRecord,
  endpoints: CertificateEndpointView[],
  issuedById: string | null,
  lastAlertDays: number | null,
  now: Date,
): CertificateView {
  const a = ci.attributes;
  const notAfter = isoAttribute(a, CERTIFICATE_ATTRIBUTES.notAfter);
  const daysLeft = notAfter === null ? null : certificateDaysLeft(notAfter, now);
  return {
    ci,
    subject: stringAttribute(a, CERTIFICATE_ATTRIBUTES.subject) ?? ci.displayName,
    issuer: stringAttribute(a, CERTIFICATE_ATTRIBUTES.issuer),
    serial: stringAttribute(a, CERTIFICATE_ATTRIBUTES.serial),
    notBefore: isoAttribute(a, CERTIFICATE_ATTRIBUTES.notBefore),
    notAfter,
    daysLeft,
    expired: daysLeft !== null && daysLeft < 0,
    selfSigned: booleanAttribute(a, CERTIFICATE_ATTRIBUTES.selfSigned) ?? false,
    isCa: booleanAttribute(a, CERTIFICATE_ATTRIBUTES.isCa) ?? false,
    keyAlgorithm: stringAttribute(a, CERTIFICATE_ATTRIBUTES.keyAlgorithm),
    keyBits: numberAttribute(a, CERTIFICATE_ATTRIBUTES.keyBits),
    signatureAlgorithm: stringAttribute(a, CERTIFICATE_ATTRIBUTES.signatureAlgorithm),
    weaknesses: certificateWeaknesses(
      { keyAlgorithm: a[CERTIFICATE_ATTRIBUTES.keyAlgorithm], keyBits: a[CERTIFICATE_ATTRIBUTES.keyBits], signatureAlgorithm: a[CERTIFICATE_ATTRIBUTES.signatureAlgorithm] },
      CERTIFICATES,
    ),
    dnsNames: stringArrayAttribute(a, CERTIFICATE_ATTRIBUTES.dnsNames),
    endpoints,
    issuedById,
    lastAlertDays,
  };
}

function matches(view: CertificateView, filter: CertificateFilter): boolean {
  if (!filter.includeAuthorities && view.isCa) return false;
  if (filter.expired !== null && view.expired !== filter.expired) return false;
  if (filter.selfSigned !== null && view.selfSigned !== filter.selfSigned) return false;
  if (filter.weak !== null && view.weaknesses.length > 0 !== filter.weak) return false;
  if (filter.expiringWithinDays !== null && (view.daysLeft === null || view.daysLeft < 0 || view.daysLeft > filter.expiringWithinDays)) return false;
  if (filter.text !== null && filter.text.trim() !== '') {
    const needle = filter.text.trim().toLowerCase();
    const hay = [view.subject, view.issuer ?? '', ...view.dnsNames, ...view.endpoints.map((e) => e.host ?? '')].join(' ').toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

@Injectable()
export class CertificatesService {
  constructor(
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly prisma: PrismaService,
  ) {}

  async certificates(tenantId: string, filter: CertificateFilter): Promise<CertificateView[]> {
    const certificates = await this.cis.byType(tenantId, 'certificate');
    if (certificates.length === 0) return [];
    const ids = certificates.map((c) => c.id);
    const [securedBy, issuedBy, alerts] = await Promise.all([
      this.cis.relationshipsOfMany(tenantId, ids, [SECURED_BY], 'upstream'),
      this.cis.relationshipsOfMany(tenantId, ids, [DEPENDS_ON], 'downstream'),
      this.prisma.client.certificateAlert.findMany({
        where: { tenantId, ciId: { in: ids } },
        orderBy: { createdAt: 'desc' },
        select: { ciId: true, thresholdDays: true },
      }),
    ]);
    const listeners = new Map((await this.cis.findByIds(tenantId, [...new Set(securedBy.map((r) => r.fromCiId))])).map((c) => [c.id, c]));
    const endpointsOf = new Map<string, CertificateEndpointView[]>();
    for (const r of securedBy) {
      const listener = listeners.get(r.fromCiId);
      if (!listener) continue;
      const endpoint: CertificateEndpointView = {
        listener,
        host: stringAttribute(listener.attributes, 'target') ?? stringAttribute(listener.identity, 'hostRef'),
        port: numberAttribute(listener.attributes, 'port'),
        serverName: stringAttribute(listener.attributes, 'serverName'),
        tlsVersion: stringAttribute(listener.attributes, 'tlsVersion'),
      };
      endpointsOf.set(r.toCiId, [...(endpointsOf.get(r.toCiId) ?? []), endpoint]);
    }
    const issuerOf = new Map<string, string>();
    for (const r of issuedBy) if (!issuerOf.has(r.fromCiId)) issuerOf.set(r.fromCiId, r.toCiId);
    const lastAlert = new Map<string, number>();
    for (const a of alerts) if (!lastAlert.has(a.ciId)) lastAlert.set(a.ciId, a.thresholdDays);
    const now = new Date();
    return certificates
      .map((ci) => toCertificateView(ci, endpointsOf.get(ci.id) ?? [], issuerOf.get(ci.id) ?? null, lastAlert.get(ci.id) ?? null, now))
      .filter((v) => matches(v, filter))
      .sort((x, y) => (x.daysLeft ?? Number.MAX_SAFE_INTEGER) - (y.daysLeft ?? Number.MAX_SAFE_INTEGER) || x.subject.localeCompare(y.subject));
  }
}
