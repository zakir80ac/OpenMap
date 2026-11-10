// REQ-INT-016 (ADR-074) — identity sources: the directories (Active Directory, any other LDAP) and OpenID Connect
// providers (Microsoft Entra ID, Okta, any other) people sign in to OpenMap through. Keycloak federates them; this file
// holds what an administrator enters, the OpenMap role a directory group grants, and the issuer each vendor's
// settings name. Secrets never appear here: a source names an OpenBao record (`secretRef`).
import { z } from 'zod';
import { IDENTITY_FEDERATION, ROLES } from '@openmap/constants';

export const IDENTITY_SOURCE_KINDS = ['ldap', 'oidc'] as const;
export type IdentitySourceKind = (typeof IDENTITY_SOURCE_KINDS)[number];

export const IDENTITY_SOURCE_VENDORS = ['active_directory', 'ldap', 'entra_id', 'okta', 'oidc'] as const;
export type IdentitySourceVendor = (typeof IDENTITY_SOURCE_VENDORS)[number];

export const LDAP_VENDORS = ['active_directory', 'ldap'] as const;
export type LdapVendor = (typeof LDAP_VENDORS)[number];
export const OIDC_VENDORS = ['entra_id', 'okta', 'oidc'] as const;
export type OidcVendor = (typeof OIDC_VENDORS)[number];

/** Vendors that are internet services: an air-gapped deployment cannot reach them, so it refuses them. */
export const CLOUD_IDENTITY_VENDORS: readonly IdentitySourceVendor[] = ['entra_id', 'okta'];

/** pending: saved, not yet in Keycloak; applied: Keycloak holds the current settings; error: the last apply failed. */
export const IDENTITY_SOURCE_STATES = ['pending', 'applied', 'error'] as const;
export type IdentitySourceState = (typeof IDENTITY_SOURCE_STATES)[number];

/** The OpenMap roles a group can grant (the Discovery Node identity is never a person's role). */
export const IDENTITY_MAPPED_ROLES = ['admin', 'operator', 'analyst', 'auditor'] as const;
export type IdentityMappedRole = (typeof IDENTITY_MAPPED_ROLES)[number];

export function vendorKind(vendor: IdentitySourceVendor): IdentitySourceKind {
  return (LDAP_VENDORS as readonly string[]).includes(vendor) ? 'ldap' : 'oidc';
}

export function isLdapVendor(vendor: IdentitySourceVendor): vendor is LdapVendor {
  return vendorKind(vendor) === 'ldap';
}

/** The Keycloak realm role a mapped role stands for. */
export function realmRoleOf(role: IdentityMappedRole): string {
  return ROLES[role];
}

/** The mapped role a realm role stands for, or null for a role OpenMap does not map (default roles, `openmap-node`). */
export function mappedRoleOf(realmRole: string): IdentityMappedRole | null {
  return IDENTITY_MAPPED_ROLES.find((r) => ROLES[r] === realmRole) ?? null;
}

const LDAP_URL = /^ldaps?:\/\/[^\s/?#]+(:\d+)?\/?$/u;
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}))+$/u;
/** An Entra directory: its id (a GUID) or one of its verified domains. */
const ENTRA_DIRECTORY = /^([0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}|[A-Za-z0-9.-]+\.[A-Za-z]{2,})$/u;
const SERVER_ID = /^[A-Za-z0-9_-]+$/u;
const LDAP_ATTRIBUTE = /^[A-Za-z][A-Za-z0-9-]*$/u;
const SCOPES = /^[\x21\x23-\x5B\x5D-\x7E]+( [\x21\x23-\x5B\x5D-\x7E]+)*$/u;
const CLAIM = /^[A-Za-z0-9_.:/-]+$/u;

const dn = z.string().trim().min(1).max(IDENTITY_FEDERATION.maxDnLength);
const optionalText = (schema: z.ZodString) => schema.nullish().transform((v) => (v === undefined || v === null || v === '' ? null : v));

export const ldapSourceInputSchema = z.object({
  connectionUrl: z.string().trim().regex(LDAP_URL, 'an ldap:// or ldaps:// URL with a host and an optional port'),
  startTls: z.boolean().nullish(),
  bindDn: dn,
  usersDn: dn,
  /** An LDAP filter narrowing the users imported, e.g. `(memberOf=CN=OpenMap,OU=Groups,DC=corp,DC=example)`. */
  userFilter: optionalText(z.string().trim().max(IDENTITY_FEDERATION.maxDnLength)),
  groupsDn: dn,
  /** The attribute people sign in with; the vendor preset when omitted (sAMAccountName for AD, uid otherwise). */
  usernameAttribute: optionalText(z.string().trim().regex(LDAP_ATTRIBUTE)),
  syncPeriodMinutes: z
    .number()
    .int()
    .min(IDENTITY_FEDERATION.minSyncPeriodMinutes)
    .max(IDENTITY_FEDERATION.maxSyncPeriodMinutes)
    .nullish(),
});
export type LdapSourceInput = z.input<typeof ldapSourceInputSchema>;

export const oidcSourceInputSchema = z.object({
  /** Generic OpenID Connect providers only: the issuer, whose discovery document Keycloak reads. */
  issuer: optionalText(z.string().trim()),
  /** Entra ID: the directory (tenant) id or a verified domain. */
  directoryTenantId: optionalText(z.string().trim().regex(ENTRA_DIRECTORY, 'a directory id (GUID) or a verified domain')),
  /** Okta: the organisation's domain (acme.okta.com or a custom domain). */
  domain: optionalText(z.string().trim().regex(HOSTNAME, 'a host name such as acme.okta.com')),
  /** Okta: a custom authorization server id (`default` is Okta's own); none is the org authorization server. */
  authorizationServerId: optionalText(z.string().trim().regex(SERVER_ID)),
  clientId: z.string().trim().min(1).max(IDENTITY_FEDERATION.maxGroupLength),
  /** Space-separated scopes; the vendor preset when omitted. */
  scopes: optionalText(z.string().trim().regex(SCOPES, 'space-separated scopes')),
  /** The claim carrying group names or ids; the vendor preset (`groups`) when omitted. */
  groupsClaim: optionalText(z.string().trim().regex(CLAIM)),
});
export type OidcSourceInput = z.input<typeof oidcSourceInputSchema>;

export const identityRoleMappingSchema = z.object({
  /** A directory group name (LDAP `cn`), or the value the provider puts in the groups claim (Entra: the group's object id). */
  group: z.string().trim().min(1).max(IDENTITY_FEDERATION.maxGroupLength),
  role: z.enum(IDENTITY_MAPPED_ROLES),
});
export type IdentityRoleMapping = z.infer<typeof identityRoleMappingSchema>;

export const identitySourceInputSchema = z
  .object({
    vendor: z.enum(IDENTITY_SOURCE_VENDORS),
    name: z.string().trim().min(1).max(IDENTITY_FEDERATION.maxNameLength),
    enabled: z.boolean().nullish(),
    /** The OpenBao record holding the bind password (`password`) or the client secret (`clientSecret`). */
    secretRef: z.string().trim().min(1),
    roleMappings: z.array(identityRoleMappingSchema).max(IDENTITY_FEDERATION.maxRoleMappings),
    ldap: ldapSourceInputSchema.nullish(),
    oidc: oidcSourceInputSchema.nullish(),
  })
  .superRefine((s, ctx) => {
    const kind = vendorKind(s.vendor);
    if (kind === 'ldap' && (s.ldap === null || s.ldap === undefined)) ctx.addIssue({ code: 'custom', path: ['ldap'], message: 'a directory needs its LDAP settings' });
    if (kind === 'ldap' && s.oidc !== null && s.oidc !== undefined) ctx.addIssue({ code: 'custom', path: ['oidc'], message: 'a directory takes no OpenID Connect settings' });
    if (kind === 'oidc' && (s.oidc === null || s.oidc === undefined)) ctx.addIssue({ code: 'custom', path: ['oidc'], message: 'an identity provider needs its OpenID Connect settings' });
    if (kind === 'oidc' && s.ldap !== null && s.ldap !== undefined) ctx.addIssue({ code: 'custom', path: ['ldap'], message: 'an identity provider takes no LDAP settings' });
    const o = s.oidc;
    if (o !== null && o !== undefined) {
      if (s.vendor === 'entra_id' && o.directoryTenantId === null) ctx.addIssue({ code: 'custom', path: ['oidc', 'directoryTenantId'], message: 'Entra ID needs the directory (tenant) id' });
      if (s.vendor === 'okta' && o.domain === null) ctx.addIssue({ code: 'custom', path: ['oidc', 'domain'], message: 'Okta needs the organisation domain' });
      if (s.vendor === 'oidc' && (o.issuer === null || !z.url({ protocol: /^https?$/u }).safeParse(o.issuer).success))
        ctx.addIssue({ code: 'custom', path: ['oidc', 'issuer'], message: 'an OpenID Connect provider needs its issuer URL' });
    }
    const seen = new Set<string>();
    s.roleMappings.forEach((m, i) => {
      const key = m.group + '\u0000' + m.role;
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['roleMappings', i], message: 'the same group is mapped to the same role twice' });
      seen.add(key);
    });
  });
export type IdentitySourceInput = z.input<typeof identitySourceInputSchema>;
export type ParsedIdentitySourceInput = z.output<typeof identitySourceInputSchema>;

/** A directory's settings with every vendor preset filled in: what is stored and applied. */
export interface LdapSourceSettings {
  connectionUrl: string;
  startTls: boolean;
  bindDn: string;
  usersDn: string;
  userFilter: string | null;
  groupsDn: string;
  usernameAttribute: string;
  syncPeriodMinutes: number | null;
}

/** An identity provider's settings with the issuer derived and the vendor presets filled in. */
export interface OidcSourceSettings {
  issuer: string;
  directoryTenantId: string | null;
  domain: string | null;
  authorizationServerId: string | null;
  clientId: string;
  scopes: string;
  groupsClaim: string;
}

export function resolveLdapSettings(vendor: LdapVendor, input: z.output<typeof ldapSourceInputSchema>): LdapSourceSettings {
  return {
    connectionUrl: input.connectionUrl.replace(/\/$/u, ''),
    startTls: input.startTls ?? false,
    bindDn: input.bindDn,
    usersDn: input.usersDn,
    userFilter: input.userFilter,
    groupsDn: input.groupsDn,
    usernameAttribute: input.usernameAttribute ?? IDENTITY_FEDERATION.ldap[vendor].usernameAttribute,
    syncPeriodMinutes: input.syncPeriodMinutes ?? null,
  };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/u, '');
}

/**
 * The issuer a provider's settings name. Entra ID: `<authority>/<directory>/v2.0` (the v2.0 endpoints, whose tokens
 * carry `groups` as object ids); Okta: `https://<domain>` (org server) or `https://<domain>/oauth2/<server>`; any other
 * provider: the issuer as entered.
 */
export function oidcIssuer(
  vendor: OidcVendor,
  input: Pick<z.output<typeof oidcSourceInputSchema>, 'issuer' | 'directoryTenantId' | 'domain' | 'authorizationServerId'>,
  entraAuthority: string,
): string {
  if (vendor === 'entra_id') return trimSlash(entraAuthority) + '/' + (input.directoryTenantId ?? '') + '/' + IDENTITY_FEDERATION.entraIssuerSuffix;
  if (vendor === 'okta') {
    const org = 'https://' + (input.domain ?? '').toLowerCase();
    return input.authorizationServerId === null ? org : org + '/' + IDENTITY_FEDERATION.oktaServerPath + '/' + input.authorizationServerId;
  }
  return trimSlash(input.issuer ?? '');
}

/** The OpenID Connect discovery document of an issuer. */
export function discoveryUrl(issuer: string): string {
  return trimSlash(issuer) + IDENTITY_FEDERATION.discoveryPath;
}

/** Two issuers name the same provider when they differ at most by a trailing slash (OIDC Discovery §4.3 compares exactly). */
export function sameIssuer(a: string, b: string): boolean {
  return trimSlash(a) === trimSlash(b);
}

export function resolveOidcSettings(vendor: OidcVendor, input: z.output<typeof oidcSourceInputSchema>, entraAuthority: string): OidcSourceSettings {
  const preset = IDENTITY_FEDERATION.oidc[vendor];
  return {
    issuer: oidcIssuer(vendor, input, entraAuthority),
    directoryTenantId: vendor === 'entra_id' ? input.directoryTenantId : null,
    domain: vendor === 'okta' ? (input.domain?.toLowerCase() ?? null) : null,
    authorizationServerId: vendor === 'okta' ? input.authorizationServerId : null,
    clientId: input.clientId,
    scopes: input.scopes ?? preset.scopes,
    groupsClaim: input.groupsClaim ?? preset.groupsClaim,
  };
}

/**
 * The Keycloak alias of a source: `openmap-<name as a slug>-<first characters of the id>`. Lower-case letters, digits
 * and hyphens only, so it is safe in a URL path (the broker's redirect URI) and as a group name.
 */
export function identitySourceAlias(name: string, id: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  const suffix = id.replace(/-/gu, '').slice(0, IDENTITY_FEDERATION.aliasSuffixLength).toLowerCase();
  return [IDENTITY_FEDERATION.objectPrefix, slug, suffix].filter((p) => p !== '').join('-');
}
