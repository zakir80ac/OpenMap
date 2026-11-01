// REQ-UI-015 REQ-UI-016 REQ-CMDB-030 REQ-CMDB-031 REQ-CMDB-035 REQ-SEC-008 — view types for the software inventory,
// licence compliance and vulnerability screens (ADR-013).
import type { CiRecord } from '../ci/ci.types.js';
import type { Money } from '../common/money.js';
import type { AffectedServiceView } from '../graph/graph.types.js';

export interface LicenceSummaryView {
  ci: CiRecord;
  metric: string;
  licenceType: string;
  entitlement: number;
  consumed: number;
  overDeployed: boolean;
  expiresAt: string | null;
  expired: boolean;
  annualCost: Money | null;
  contract: CiRecord | null;
}

export interface SoftwareProductView {
  ci: CiRecord;
  vendor: string;
  name: string;
  version: string;
  category: string | null;
  endOfSupport: string | null;
  instances: number;
  hosts: number;
  running: number;
  licence: LicenceSummaryView | null;
  vulnerabilities: number;
}

export interface VulnerabilitySummaryView {
  ci: CiRecord;
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

export interface VulnerabilityDetailView {
  summary: VulnerabilitySummaryView;
  software: CiRecord[];
  hosts: CiRecord[];
  services: AffectedServiceView[];
  /** True when more hosts exist than the blast-radius walk covered. */
  blastRadiusTruncated: boolean;
}
