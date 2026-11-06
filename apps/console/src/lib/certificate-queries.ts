// REQ-CMDB-032 (ADR-036) — GraphQL operations behind the Certificates screen.
import { queryOptions } from '@tanstack/react-query';
import { gql } from './graphql';
import { CI_SUMMARY_FIELDS, type CiSummary } from './queries';

export interface CertificateEndpoint {
  listener: CiSummary;
  host: string | null;
  port: number | null;
  serverName: string | null;
  tlsVersion: string | null;
}

export interface Certificate {
  ci: CiSummary;
  subject: string;
  issuer: string | null;
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
  endpoints: CertificateEndpoint[];
  issuedBy: { id: string; displayName: string } | null;
  lastAlertDays: number | null;
}

export interface CertificateFilter {
  text?: string;
  expiringWithinDays?: number;
  expired?: boolean;
  selfSigned?: boolean;
  weak?: boolean;
  includeAuthorities?: boolean;
}

const CERTIFICATE_FIELDS =
  'ci { ' +
  CI_SUMMARY_FIELDS +
  ' } subject issuer notAfter daysLeft expired selfSigned isCa keyAlgorithm keyBits signatureAlgorithm weaknesses dnsNames endpoints { listener { ' +
  CI_SUMMARY_FIELDS +
  ' } host port serverName tlsVersion } issuedBy { id displayName } lastAlertDays';
const CERTIFICATES_QUERY = 'query Certificates($filter: CertificateFilter) { certificates(filter: $filter) { ' + CERTIFICATE_FIELDS + ' } }';

export function certificatesQuery(filter: CertificateFilter) {
  return queryOptions({
    queryKey: ['certificates', filter] as const,
    queryFn: ({ signal }) => gql<{ certificates: Certificate[] }>(CERTIFICATES_QUERY, { filter }, signal).then((d) => d.certificates),
  });
}
