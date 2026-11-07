// REQ-UI-020 REQ-UI-024 — typed operations of the initial setup (ADR-017, GraphQL 0.9.0): the `onboarding` state and
// the mutations each step of the wizard calls. Only the fields the wizard renders are selected.
import { queryOptions } from '@tanstack/react-query';
import { CONSOLE } from '@openmap/constants';
import type { CiLayer, ONBOARDING_STEPS, SITE_KINDS } from '@openmap/contracts';
import type { Integration } from './estate-queries';
import { gql } from './graphql';
import type { DiscoveryNode, Sweep } from './queries';

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type SiteKind = (typeof SITE_KINDS)[number];

export interface BusinessUnit {
  tenantId: string;
  name: string;
  slug: string;
}

export interface Organization {
  id: string;
  name: string;
  industry: string;
  timeZone: string;
  defaultLocale: string;
  regulatoryScope: string[];
  airGapped: boolean;
  businessUnits: BusinessUnit[];
  createdAt: string;
}

export interface OrganizationInput {
  name: string;
  industry: string;
  timeZone: string;
  defaultLocale: string;
  regulatoryScope: string[];
  airGapped: boolean;
  businessUnits: Array<{ tenantId: string | null; name: string }>;
}

export interface SiteCi {
  id: string;
  code: string;
  displayName: string;
  layer: CiLayer;
}

export interface Site {
  id: string;
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
  /** ADR-025: the site's part in disaster recovery and its business criticality (1 = most critical). */
  drRole: SiteDrRole;
  criticality: number | null;
  ci: SiteCi | null;
  nodes: DiscoveryNode[];
}

export type SiteDrRole = 'primary' | 'dr' | 'none';

export interface SiteInput {
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
  drRole: SiteDrRole;
  criticality: number | null;
}

export interface SiteLink {
  id: string;
  fromSite: { id: string; code: string; name: string };
  toSite: { id: string; code: string; name: string };
  kind: string;
  provider: string | null;
  circuitId: string | null;
  bandwidthMbps: number;
  diversePaths: number;
  role: string;
  latencyMs: number | null;
  /** ADR-025: the link carries replication; what a Node at the A end probes. */
  replication: boolean;
  probeTarget: string | null;
  ci: SiteCi | null;
}

export interface SiteLinkInput {
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
}

export interface NodeRegistration {
  node: DiscoveryNode;
  siteCode: string;
  enrolToken: string;
  schedulerUrl: string;
}

export interface CredentialSet {
  ref: string;
  type: string;
  fields: string[];
}

export interface CredentialSetInput {
  ref: string;
  type: string;
  fields: Record<string, string>;
}

export interface SetupScope {
  ci: SiteCi;
  cidr: string;
  site: SiteCi | null;
  credentialRef: string | null;
  credentialType: string;
}

export interface ScopeInput {
  cidr: string;
  vrf: string | null;
  siteId: string;
  credentialRef: string | null;
  credentialType: string | null;
}

export interface OnboardingState {
  organization: Organization;
  step: OnboardingStep;
  completedSteps: OnboardingStep[];
  sites: Site[];
  links: SiteLink[];
  nodes: DiscoveryNode[];
  credentials: CredentialSet[];
  scopes: SetupScope[];
  integrations: Integration[];
  generatedAt: string | null;
  firstSweep: Sweep | null;
  schedulerUrl: string;
}

const ORGANIZATION_FIELDS = 'id name industry timeZone defaultLocale regulatoryScope airGapped createdAt businessUnits { tenantId name slug }';
const SITE_CI_FIELDS = 'ci { id code displayName layer }';
const NODE_FIELDS = 'id status lastHeartbeat activeJobs certificateExpiresAt site { id displayName }';
const SITE_FIELDS = 'id code name kind tier address city countryCode geo { lat lon } cloud { provider region } locationCount facility { powerCapacityKw rackCount designPue } drRole criticality ' + SITE_CI_FIELDS + ' nodes { ' + NODE_FIELDS + ' }';
const LINK_FIELDS = 'id fromSite { id code name } toSite { id code name } kind provider circuitId bandwidthMbps diversePaths role latencyMs replication probeTarget ' + SITE_CI_FIELDS;
const SWEEP_FIELDS = 'id startedAt finishedAt targetsTotal targetsDone devicesDiscovered budgetMinutes';
const SCOPE_FIELDS = 'ci { id code displayName layer } cidr site { id code displayName layer } credentialRef credentialType';
const INTEGRATION_FIELDS = 'id category vendor name enabled direction health lastSuccessAt lastError deliveredLastHour failedLastHour';

const ONBOARDING_QUERY = [
  'query Onboarding {',
  '  onboarding {',
  '    organization { ' + ORGANIZATION_FIELDS + ' }',
  '    step completedSteps generatedAt schedulerUrl',
  '    sites { ' + SITE_FIELDS + ' }',
  '    links { ' + LINK_FIELDS + ' }',
  '    nodes { ' + NODE_FIELDS + ' }',
  '    credentials { ref type fields }',
  '    scopes { ' + SCOPE_FIELDS + ' }',
  '    integrations { ' + INTEGRATION_FIELDS + ' }',
  '    firstSweep { ' + SWEEP_FIELDS + ' }',
  '  }',
  '}',
].join('\n');

export const onboardingQueryKey = ['onboarding'] as const;

export function onboardingQuery(live = false) {
  return queryOptions({
    queryKey: onboardingQueryKey,
    queryFn: ({ signal }) => gql<{ onboarding: OnboardingState }>(ONBOARDING_QUERY, undefined, signal),
    select: (data) => data.onboarding,
    ...(live ? { refetchInterval: CONSOLE.livePollMs } : {}),
  });
}

export function updateOrganization(input: OrganizationInput): Promise<Organization> {
  return gql<{ updateOrganization: Organization }>('mutation UpdateOrganization($input: OrganizationInput!) { updateOrganization(input: $input) { ' + ORGANIZATION_FIELDS + ' } }', { input }).then((d) => d.updateOrganization);
}

export function upsertSite(id: string | null, input: SiteInput): Promise<Site> {
  return gql<{ upsertSite: Site }>('mutation UpsertSite($id: UUID, $input: SiteInput!) { upsertSite(id: $id, input: $input) { ' + SITE_FIELDS + ' } }', { id, input }).then((d) => d.upsertSite);
}

export function removeSite(id: string): Promise<boolean> {
  return gql<{ removeSite: boolean }>('mutation RemoveSite($id: UUID!) { removeSite(id: $id) }', { id }).then((d) => d.removeSite);
}

export function upsertSiteLink(id: string | null, input: SiteLinkInput): Promise<SiteLink> {
  return gql<{ upsertSiteLink: SiteLink }>('mutation UpsertSiteLink($id: UUID, $input: SiteLinkInput!) { upsertSiteLink(id: $id, input: $input) { ' + LINK_FIELDS + ' } }', { id, input }).then((d) => d.upsertSiteLink);
}

export function removeSiteLink(id: string): Promise<boolean> {
  return gql<{ removeSiteLink: boolean }>('mutation RemoveSiteLink($id: UUID!) { removeSiteLink(id: $id) }', { id }).then((d) => d.removeSiteLink);
}

export function registerNode(siteId: string, nodeId: string): Promise<NodeRegistration> {
  return gql<{ registerNode: NodeRegistration }>('mutation RegisterNode($siteId: UUID!, $nodeId: String!) { registerNode(siteId: $siteId, nodeId: $nodeId) { node { ' + NODE_FIELDS + ' } siteCode enrolToken schedulerUrl } }', { siteId, nodeId }).then((d) => d.registerNode);
}

export function saveCredentialSet(input: CredentialSetInput): Promise<CredentialSet> {
  return gql<{ saveCredentialSet: CredentialSet }>('mutation SaveCredentialSet($input: CredentialSetInput!) { saveCredentialSet(input: $input) { ref type fields } }', { input }).then((d) => d.saveCredentialSet);
}

export function addDiscoveryScope(input: ScopeInput): Promise<SetupScope> {
  return gql<{ addDiscoveryScope: SetupScope }>('mutation AddDiscoveryScope($input: ScopeInput!) { addDiscoveryScope(input: $input) { ' + SCOPE_FIELDS + ' } }', { input }).then((d) => d.addDiscoveryScope);
}

export function setOnboardingStep(step: OnboardingStep, completed: boolean): Promise<OnboardingState> {
  return gql<{ setOnboardingStep: OnboardingState }>('mutation SetOnboardingStep($step: OnboardingStep!, $completed: Boolean!) { setOnboardingStep(step: $step, completed: $completed) { step completedSteps generatedAt schedulerUrl organization { ' + ORGANIZATION_FIELDS + ' } sites { ' + SITE_FIELDS + ' } links { ' + LINK_FIELDS + ' } nodes { ' + NODE_FIELDS + ' } credentials { ref type fields } scopes { ' + SCOPE_FIELDS + ' } integrations { ' + INTEGRATION_FIELDS + ' } firstSweep { ' + SWEEP_FIELDS + ' } } }', { step, completed }).then((d) => d.setOnboardingStep);
}

export function generateTwin(): Promise<OnboardingState> {
  return gql<{ generateTwin: OnboardingState }>('mutation GenerateTwin { generateTwin { step completedSteps generatedAt schedulerUrl organization { ' + ORGANIZATION_FIELDS + ' } sites { ' + SITE_FIELDS + ' } links { ' + LINK_FIELDS + ' } nodes { ' + NODE_FIELDS + ' } credentials { ref type fields } scopes { ' + SCOPE_FIELDS + ' } integrations { ' + INTEGRATION_FIELDS + ' } firstSweep { ' + SWEEP_FIELDS + ' } } }').then((d) => d.generateTwin);
}
