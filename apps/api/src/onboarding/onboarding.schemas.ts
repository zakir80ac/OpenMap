// REQ-UI-024 — zod schemas of the setup mutations (ADR-017). They reuse the contract's site and link schemas where
// the GraphQL input mirrors them, so nothing the organization contract would refuse is stored.
import { CREDENTIAL_REF_PATTERN, LINK_CIRCUITS, LOCALES, SETUP_LIMITS, SETUP_PATTERNS } from '@openmap/constants';
import { CREDENTIAL_FIELDS, credentialTypeSchema, LINK_KINDS, ONBOARDING_STEPS, SITE_KINDS, siteDrRoleSchema } from '@openmap/contracts';
import { z } from 'zod';

const SITE_CODE = SETUP_PATTERNS.siteCode;
const NODE_ID = SETUP_PATTERNS.nodeId;
/** OpenBao KV path below the mount, as the scheduler's secrets reader accepts it; `..` is refused separately. */
const CREDENTIAL_REF = CREDENTIAL_REF_PATTERN;
const CIDR = SETUP_PATTERNS.cidrV4;
const COUNTRY = SETUP_PATTERNS.countryCode;

export const businessUnitInputSchema = z.object({ tenantId: z.uuid().nullish(), name: z.string().trim().min(1) });

export const organizationInputSchema = z.object({
  name: z.string().trim().min(1),
  industry: z.string().trim().min(1),
  timeZone: z.string().trim().min(1),
  defaultLocale: z.enum(LOCALES),
  regulatoryScope: z.array(z.string().trim().min(1)),
  airGapped: z.boolean(),
  businessUnits: z.array(businessUnitInputSchema).min(1),
});
export type OrganizationInput = z.infer<typeof organizationInputSchema>;

export const siteInputSchema = z.object({
  code: z.string().trim().toUpperCase().regex(SITE_CODE),
  name: z.string().trim().min(1),
  kind: z.enum(SITE_KINDS),
  tier: z.number().int().min(1).max(SETUP_LIMITS.maxTier).nullish(),
  address: z.string().trim(),
  city: z.string().trim().min(1),
  countryCode: z.string().trim().toUpperCase().regex(COUNTRY),
  geo: z.object({ lat: z.number().min(-SETUP_LIMITS.latitudeMax).max(SETUP_LIMITS.latitudeMax), lon: z.number().min(-SETUP_LIMITS.longitudeMax).max(SETUP_LIMITS.longitudeMax) }).nullish(),
  cloud: z.object({ provider: z.enum(['azure', 'aws', 'gcp', 'oci', 'other']), region: z.string().trim().min(1) }).nullish(),
  locationCount: z.number().int().positive(),
  facility: z.object({ powerCapacityKw: z.number().min(0), rackCount: z.number().int().min(0), designPue: z.number().min(1).nullish() }).nullish(),
  /** ADR-025: the site's part in disaster recovery and its business criticality (1 = most critical). */
  drRole: siteDrRoleSchema.nullish(),
  criticality: z.number().int().min(1).max(SETUP_LIMITS.maxCriticality).nullish(),
});
export type SiteInput = z.infer<typeof siteInputSchema>;

export const siteLinkInputSchema = z.object({
  fromSiteId: z.uuid(),
  toSiteId: z.uuid(),
  kind: z.enum(LINK_KINDS),
  provider: z.string().trim().min(1).nullish(),
  circuitId: z.string().trim().min(1).nullish(),
  bandwidthMbps: z.number().int().positive(),
  diversePaths: z.number().int().positive(),
  role: z.enum(['primary', 'backup', 'overlay']),
  latencyMs: z.number().min(0).nullish(),
  /** ADR-025: the link carries replication; what a Node at the A end probes (host or host:port). */
  replication: z.boolean().nullish(),
  probeTarget: z.string().trim().min(1).nullish(),
  /** ADR-069 (REQ-IPAM-007): the carrier contract, the committed latency and the physical route. */
  carrierContractRef: z.string().trim().min(1).max(LINK_CIRCUITS.maxRefChars).nullish(),
  slaLatencyMs: z.number().int().positive().nullish(),
  pathRef: z.string().trim().min(1).max(LINK_CIRCUITS.maxRefChars).nullish(),
});
export type SiteLinkInput = z.infer<typeof siteLinkInputSchema>;

export const registerNodeArgsSchema = z.object({ siteId: z.uuid(), nodeId: z.string().trim().regex(NODE_ID) });

export const credentialSetInputSchema = z
  .object({
    ref: z.string().trim().regex(CREDENTIAL_REF).refine((ref) => !ref.includes('..'), { message: 'credential reference must not traverse' }),
    type: credentialTypeSchema,
    fields: z.record(z.string().min(1), z.string()),
  })
  .superRefine((input, ctx) => {
    const spec = CREDENTIAL_FIELDS[input.type];
    for (const name of spec.required) {
      if ((input.fields[name] ?? '').trim() === '') ctx.addIssue({ code: 'custom', path: ['fields', name], message: name + ' is required for ' + input.type });
    }
    const allowed = new Set([...spec.required, ...spec.optional]);
    for (const name of Object.keys(input.fields)) {
      if (!allowed.has(name)) ctx.addIssue({ code: 'custom', path: ['fields', name], message: name + ' is not a field of ' + input.type });
    }
  });
export type CredentialSetInput = z.infer<typeof credentialSetInputSchema>;

export const scopeInputSchema = z.object({
  cidr: z.string().trim().regex(CIDR),
  vrf: z.string().trim().min(1).nullish(),
  siteId: z.uuid(),
  credentialRef: z.string().trim().regex(CREDENTIAL_REF).nullish(),
  credentialType: credentialTypeSchema.nullish(),
});
export type ScopeInput = z.infer<typeof scopeInputSchema>;

export const onboardingStepArgsSchema = z.object({ step: z.enum(ONBOARDING_STEPS), completed: z.boolean() });
