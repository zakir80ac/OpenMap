// REQ-UI-015 REQ-UI-016 — GraphQL operations behind the Software and licences and Vulnerabilities screens (ADR-013).
import { queryOptions } from '@tanstack/react-query';
import { GRAPH } from '@openmap/constants';
import { gql } from './graphql';
import { CI_SUMMARY_FIELDS, type CiSummary } from './queries';
import type { Money } from './estate-queries';

export interface LicenceSummary {
  ci: CiSummary;
  metric: string;
  licenceType: string;
  entitlement: number;
  consumed: number;
  overDeployed: boolean;
  expiresAt: string | null;
  expired: boolean;
  annualCost: Money | null;
  contract: CiSummary | null;
}

export interface SoftwareProduct {
  ci: CiSummary;
  vendor: string;
  name: string;
  version: string;
  category: string | null;
  endOfSupport: string | null;
  instances: number;
  hosts: number;
  running: number;
  licence: LicenceSummary | null;
  vulnerabilities: number;
}

export interface VulnerabilitySummary {
  ci: CiSummary;
  cveId: string;
  title: string;
  severity: string;
  cvss: number;
  exploited: boolean;
  cisaKev: boolean;
  patchAvailable: boolean;
  publishedAt: string | null;
  internetFacing: boolean;
  affectedSoftware: number;
  affectedHosts: number;
  fixedIn: string | null;
}

export interface AffectedService {
  service: CiSummary;
  tier: number;
  predicted: string;
  usersAffected: number | null;
  slaBudgetRemainingMinutes: number | null;
}

export interface VulnerabilityDetail {
  summary: VulnerabilitySummary;
  software: CiSummary[];
  hosts: CiSummary[];
  services: AffectedService[];
  blastRadiusTruncated: boolean;
}

const LICENCE_FIELDS = 'licence { ci { ' + CI_SUMMARY_FIELDS + ' } metric licenceType entitlement consumed overDeployed expiresAt expired annualCost { amount currency } contract { ' + CI_SUMMARY_FIELDS + ' } }';
const SOFTWARE_QUERY = 'query Software($text: String, $licensedOnly: Boolean, $first: Int) { software(text: $text, licensedOnly: $licensedOnly, first: $first) { ci { ' + CI_SUMMARY_FIELDS + ' } vendor name version category endOfSupport instances hosts running vulnerabilities ' + LICENCE_FIELDS + ' } }';
const SUMMARY_FIELDS = 'ci { ' + CI_SUMMARY_FIELDS + ' } cveId title severity cvss exploited cisaKev patchAvailable publishedAt internetFacing affectedSoftware affectedHosts fixedIn';
const VULNERABILITIES_QUERY = 'query VulnerabilitySummaries($minCvss: Float, $exploitedOnly: Boolean, $internetFacing: Boolean) { vulnerabilitySummaries(minCvss: $minCvss, exploitedOnly: $exploitedOnly, internetFacing: $internetFacing) { ' + SUMMARY_FIELDS + ' } }';
const VULNERABILITY_QUERY = 'query Vulnerability($cveId: String!) { vulnerability(cveId: $cveId) { summary { ' + SUMMARY_FIELDS + ' } software { ' + CI_SUMMARY_FIELDS + ' } hosts { ' + CI_SUMMARY_FIELDS + ' } services { service { ' + CI_SUMMARY_FIELDS + ' } tier predicted usersAffected slaBudgetRemainingMinutes } blastRadiusTruncated } }';

export interface SoftwareFilter {
  text?: string | null;
  licensedOnly?: boolean;
}

export function softwareQuery(filter: SoftwareFilter, first: number = GRAPH.maxPageSize) {
  return queryOptions({
    queryKey: ['software', filter, first] as const,
    queryFn: ({ signal }) => gql<{ software: SoftwareProduct[] }>(SOFTWARE_QUERY, { text: filter.text ?? null, licensedOnly: filter.licensedOnly ?? false, first }, signal).then((d) => d.software),
  });
}

export interface VulnerabilityFilter {
  minCvss?: number | null;
  exploitedOnly?: boolean;
  internetFacing?: boolean | null;
}

export function vulnerabilitiesQuery(filter: VulnerabilityFilter) {
  return queryOptions({
    queryKey: ['vulnerabilitySummaries', filter] as const,
    queryFn: ({ signal }) => gql<{ vulnerabilitySummaries: VulnerabilitySummary[] }>(VULNERABILITIES_QUERY, { minCvss: filter.minCvss ?? null, exploitedOnly: filter.exploitedOnly ?? false, internetFacing: filter.internetFacing ?? null }, signal).then((d) => d.vulnerabilitySummaries),
  });
}

export function vulnerabilityQuery(cveId: string) {
  return queryOptions({
    queryKey: ['vulnerability', cveId] as const,
    queryFn: ({ signal }) => gql<{ vulnerability: VulnerabilityDetail | null }>(VULNERABILITY_QUERY, { cveId }, signal).then((d) => d.vulnerability),
  });
}
