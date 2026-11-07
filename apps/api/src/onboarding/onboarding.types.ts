// REQ-UI-024 REQ-UI-020 — view types of the initial setup (ADR-017): the organization, its sites and links as the
// GraphQL Organization / Site / SiteLink / OnboardingState types serve them. Credential sets carry field names only.
import type { ONBOARDING_STEPS, SITE_KINDS } from '@openmap/contracts';
import type { DiscoveryNodeView } from '../discovery/discovery.types.js';

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type SiteKind = (typeof SITE_KINDS)[number];

export interface BusinessUnitView {
  tenantId: string;
  name: string;
  slug: string;
}

export interface OrganizationView {
  id: string;
  name: string;
  industry: string;
  timeZone: string;
  defaultLocale: string;
  regulatoryScope: string[];
  airGapped: boolean;
  businessUnits: BusinessUnitView[];
  createdAt: string;
}

export interface SiteView {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  kind: SiteKind;
  tier: number | null;
  address: string;
  city: string;
  countryCode: string;
  geo: { lat: number; lon: number } | null;
  cloud: { provider: string; region: string } | null;
  locationCount: number;
  facility: { powerCapacityKw: number; rackCount: number; designPue: number | null } | null;
  drRole: 'primary' | 'dr' | 'none';
  criticality: number | null;
  ciId: string | null;
}

export interface SiteLinkView {
  id: string;
  fromSiteId: string;
  toSiteId: string;
  kind: string;
  provider: string | null;
  circuitId: string | null;
  bandwidthMbps: number;
  diversePaths: number;
  role: string;
  latencyMs: number | null;
  replication: boolean;
  probeTarget: string | null;
  ciId: string | null;
}

export interface CredentialSetView {
  ref: string;
  type: string;
  fields: string[];
}

export interface OnboardingStateView {
  organization: OrganizationView;
  step: OnboardingStep;
  completedSteps: OnboardingStep[];
  credentialRefs: string[];
  integrationIds: string[];
  generatedAt: string | null;
  firstSweepId: string | null;
  schedulerUrl: string;
}

export interface NodeRegistrationView {
  node: DiscoveryNodeView;
  siteCode: string;
  enrolToken: string;
  schedulerUrl: string;
}
