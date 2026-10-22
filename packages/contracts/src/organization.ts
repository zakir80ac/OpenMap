// REQ-CORE-009 — organization and site contract: the root of the digital twin. Onboarding creates
// the organization, its business units (tenants), sites, inter-site links and Discovery Node
// enrolments; discovery keeps everything below the sites live.
import { z } from 'zod';
import { LOCALES } from '@openmap/constants';

export const SITE_KINDS = ['datacenter', 'colocation', 'office', 'branch', 'cloud_region', 'edge'] as const;
export const siteKindSchema = z.enum(SITE_KINDS);

export const organizationSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  industry: z.string().min(1),
  timeZone: z.string().min(1),
  defaultLocale: z.enum(LOCALES),
  /** Regulatory frameworks in scope, free text codes such as SAMA CSF, NCA ECC, PCI DSS. */
  regulatoryScope: z.array(z.string().min(1)),
  /** Business units become tenants with scoped views. */
  businessUnits: z.array(z.object({ tenantId: z.uuid(), name: z.string().min(1) })),
  airGapped: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type Organization = z.infer<typeof organizationSchema>;

export const siteSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  /** Short code used in CI names and Node ids, e.g. RYD. */
  code: z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,11}$/),
  name: z.string().min(1),
  kind: siteKindSchema,
  /** Uptime Institute tier for data centres and colocation; null otherwise. */
  tier: z.number().int().min(1).max(4).nullable(),
  address: z.string(),
  city: z.string().min(1),
  countryCode: z.string().length(2),
  geo: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).nullable(),
  /** Cloud provider and region id for cloud_region sites. */
  cloud: z.object({ provider: z.enum(['azure', 'aws', 'gcp', 'oci', 'other']), region: z.string().min(1) }).nullable(),
  /** Branch bundles: number of locations represented by this one site record. */
  locationCount: z.number().int().positive(),
  /** The site CI created in the CMDB once the twin is generated. */
  ciId: z.uuid().nullable(),
});
export type Site = z.infer<typeof siteSchema>;

export const LINK_KINDS = ['dark_fibre', 'dwdm', 'mpls', 'sd_wan', 'dia', 'expressroute', 'direct_connect', 'cloud_interconnect', 'vpn', 'point_to_point', 'cellular'] as const;

export const siteLinkSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  fromSiteId: z.uuid(),
  toSiteId: z.uuid(),
  kind: z.enum(LINK_KINDS),
  provider: z.string().nullable(),
  circuitId: z.string().nullable(),
  bandwidthMbps: z.number().int().positive(),
  /** Number of physically diverse paths; 1 means a single point of failure. */
  diversePaths: z.number().int().positive(),
  role: z.enum(['primary', 'backup', 'overlay']),
  latencyMs: z.number().min(0).nullable(),
  ciId: z.uuid().nullable(),
});
export type SiteLink = z.infer<typeof siteLinkSchema>;

export const nodeEnrolmentSchema = z.object({
  siteId: z.uuid(),
  nodeId: z.string().min(1),
  status: z.enum(['pending', 'enrolled', 'cloud_managed', 'agent_only']),
  /** One-time token hash; the clear token is shown once in the wizard. */
  enrolTokenDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  enrolledAt: z.iso.datetime().nullable(),
  certificateExpiresAt: z.iso.datetime().nullable(),
});

export const ONBOARDING_STEPS = ['organization', 'sites', 'connectivity', 'nodes_credentials', 'integrations', 'generate'] as const;

export const onboardingSchema = z.object({
  organizationId: z.uuid(),
  step: z.enum(ONBOARDING_STEPS),
  completedSteps: z.array(z.enum(ONBOARDING_STEPS)),
  credentialRefs: z.array(z.string().min(1)),
  integrationIds: z.array(z.uuid()),
  seedImports: z.array(z.object({ source: z.string().min(1), estimatedCis: z.number().int().min(0), confidence: z.number().min(0).max(1) })),
  generatedAt: z.iso.datetime().nullable(),
  firstSweepId: z.uuid().nullable(),
});
export type Onboarding = z.infer<typeof onboardingSchema>;
