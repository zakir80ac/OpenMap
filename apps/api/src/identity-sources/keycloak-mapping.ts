// REQ-INT-016 (ADR-074) — an identity source as Keycloak representations. Pure functions: a directory becomes an LDAP
// user-storage component (read-only, users imported, Keycloak's vendor presets) with two mappers of OpenMap's (the
// directory's groups imported below the group `/<alias>`, and the tenant attribute every user carries); an OpenID
// Connect provider becomes a brokered identity provider (endpoints from its discovery document, PKCE, the client secret
// posted) with a tenant mapper and one claim-to-role mapper per group mapping. Group mappings become realm roles on the
// groups below `/<alias>`. Keycloak's own identifiers (provider ids, mapper types) are KEYCLOAK_PROVIDERS in @openmap/constants.
import { IDENTITY_FEDERATION, KEYCLOAK_PROVIDERS, TIME } from '@openmap/constants';
import {
  realmRoleOf,
  type IdentityRoleMapping,
  type LdapSourceSettings,
  type LdapVendor,
  type OidcSourceSettings,
} from '@openmap/contracts';
import { z } from 'zod';
import { baseUrl } from '../auth/jwks.provider.js';

export const KEYCLOAK = KEYCLOAK_PROVIDERS;

/** Names of the Keycloak objects OpenMap owns below a source. */
export const OWNED = {
  groupsMapper: IDENTITY_FEDERATION.objectPrefix + '-groups',
  tenantMapper: IDENTITY_FEDERATION.objectPrefix + '-tenant',
  rolePrefix: IDENTITY_FEDERATION.objectPrefix + '-role:',
} as const;

export interface ComponentRepresentation {
  id?: string;
  name: string;
  providerId: string;
  providerType: string;
  parentId: string;
  config: Record<string, string[]>;
}

export interface IdentityProviderRepresentation {
  alias: string;
  displayName: string;
  providerId: string;
  enabled: boolean;
  trustEmail: boolean;
  storeToken: boolean;
  firstBrokerLoginFlowAlias: string;
  config: Record<string, string>;
}

export interface IdentityProviderMapperRepresentation {
  id?: string;
  name: string;
  identityProviderAlias: string;
  identityProviderMapper: string;
  config: Record<string, string>;
}

function bool(v: boolean): string {
  return v ? 'true' : 'false';
}

function config(entries: Record<string, string>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, [v]]));
}

/** The group every group of a directory is imported below, and the parent of the groups that carry roles. */
export function groupsPath(alias: string): string {
  return '/' + alias;
}

export function syncPeriodSeconds(minutes: number | null): string {
  return minutes === null ? KEYCLOAK.noPeriod : String(minutes * TIME.secondsPerMinute);
}

export interface LdapSourceRow {
  alias: string;
  vendor: LdapVendor;
  enabled: boolean;
  settings: LdapSourceSettings;
}

/** The user-storage component of a directory: read-only, users imported, the vendor's attribute presets. */
export function ldapComponent(source: LdapSourceRow, realmId: string, bindCredential: string): ComponentRepresentation {
  const preset = IDENTITY_FEDERATION.ldap[source.vendor];
  const s = source.settings;
  return {
    name: source.alias,
    providerId: KEYCLOAK.ldapProvider,
    providerType: KEYCLOAK.userStorageType,
    parentId: realmId,
    config: config({
      enabled: bool(source.enabled),
      vendor: preset.keycloakVendor,
      connectionUrl: s.connectionUrl,
      startTls: bool(s.startTls),
      useTruststoreSpi: 'always',
      connectionPooling: 'true',
      connectionTimeout: String(IDENTITY_FEDERATION.ldapConnectionTimeoutMs),
      authType: 'simple',
      bindDn: s.bindDn,
      bindCredential,
      usersDn: s.usersDn,
      customUserSearchFilter: s.userFilter ?? '',
      searchScope: KEYCLOAK.subtreeScope,
      usernameLDAPAttribute: s.usernameAttribute,
      rdnLDAPAttribute: preset.rdnAttribute,
      uuidLDAPAttribute: preset.uuidAttribute,
      userObjectClasses: preset.userObjectClasses,
      editMode: 'READ_ONLY',
      importEnabled: 'true',
      syncRegistrations: 'false',
      trustEmail: 'false',
      pagination: 'true',
      batchSizeForSync: String(IDENTITY_FEDERATION.ldapSyncBatchSize),
      fullSyncPeriod: syncPeriodSeconds(s.syncPeriodMinutes),
      changedSyncPeriod: KEYCLOAK.noPeriod,
      cachePolicy: 'DEFAULT',
      allowKerberosAuthentication: 'false',
      useKerberosForPasswordAuthentication: 'false',
    }),
  };
}

/** Imports the directory's groups below `/<alias>` and reads membership from the groups' member attribute (DNs). */
export function ldapGroupMapper(source: LdapSourceRow, componentId: string): ComponentRepresentation {
  const preset = IDENTITY_FEDERATION.ldap[source.vendor];
  return {
    name: OWNED.groupsMapper,
    providerId: KEYCLOAK.groupMapperProvider,
    providerType: KEYCLOAK.ldapMapperType,
    parentId: componentId,
    config: config({
      'groups.dn': source.settings.groupsDn,
      'group.name.ldap.attribute': preset.groupNameAttribute,
      'group.object.classes': preset.groupObjectClasses,
      'preserve.group.inheritance': 'false',
      'ignore.missing.groups': 'true',
      'membership.ldap.attribute': preset.membershipAttribute,
      'membership.attribute.type': 'DN',
      'membership.user.ldap.attribute': source.settings.usernameAttribute,
      'groups.ldap.filter': '',
      mode: 'READ_ONLY',
      'user.roles.retrieve.strategy': 'LOAD_GROUPS_BY_MEMBER_ATTRIBUTE',
      'memberof.ldap.attribute': 'memberOf',
      'drop.non.existing.groups.during.sync': 'false',
      'groups.path': groupsPath(source.alias),
    }),
  };
}

/** Every user of the directory carries the tenant attribute the realm's `tenant` token mapper reads. */
export function ldapTenantMapper(componentId: string, tenantId: string): ComponentRepresentation {
  return {
    name: OWNED.tenantMapper,
    providerId: KEYCLOAK.attributeMapperProvider,
    providerType: KEYCLOAK.ldapMapperType,
    parentId: componentId,
    config: config({ 'user.model.attribute': IDENTITY_FEDERATION.tenantAttribute, 'attribute.value': tenantId }),
  };
}

/** Keycloak's answer to `identity-provider/import-config`: the endpoints read from the discovery document. */
export const discoveredEndpointsSchema = z.object({
  issuer: z.string().min(1),
  authorizationUrl: z.string().min(1),
  tokenUrl: z.string().min(1),
  jwksUrl: z.string().min(1).optional(),
  userInfoUrl: z.string().min(1).optional(),
  logoutUrl: z.string().min(1).optional(),
});
export type DiscoveredEndpoints = z.infer<typeof discoveredEndpointsSchema>;

export interface OidcSourceRow {
  alias: string;
  name: string;
  enabled: boolean;
  settings: OidcSourceSettings;
}

/** A brokered OpenID Connect provider: authorization code with PKCE, the client secret posted, signatures checked. */
export function oidcProvider(source: OidcSourceRow, endpoints: DiscoveredEndpoints, clientSecret: string): IdentityProviderRepresentation {
  const optional: Record<string, string> = {};
  if (endpoints.jwksUrl !== undefined) optional['jwksUrl'] = endpoints.jwksUrl;
  if (endpoints.userInfoUrl !== undefined) optional['userInfoUrl'] = endpoints.userInfoUrl;
  if (endpoints.logoutUrl !== undefined) optional['logoutUrl'] = endpoints.logoutUrl;
  return {
    alias: source.alias,
    displayName: source.name,
    providerId: KEYCLOAK.oidcProvider,
    enabled: source.enabled,
    trustEmail: false,
    storeToken: false,
    firstBrokerLoginFlowAlias: IDENTITY_FEDERATION.firstBrokerLoginFlow,
    config: {
      issuer: endpoints.issuer,
      authorizationUrl: endpoints.authorizationUrl,
      tokenUrl: endpoints.tokenUrl,
      ...optional,
      useJwksUrl: bool(endpoints.jwksUrl !== undefined),
      validateSignature: 'true',
      clientId: source.settings.clientId,
      clientSecret,
      clientAuthMethod: 'client_secret_post',
      defaultScope: source.settings.scopes,
      pkceEnabled: 'true',
      pkceMethod: 'S256',
      syncMode: 'FORCE',
      backchannelSupported: 'false',
    },
  };
}

/** The mapper name of one group mapping; Keycloak wants names unique per provider. */
export function roleMapperName(mapping: IdentityRoleMapping): string {
  return OWNED.rolePrefix + mapping.role + ':' + mapping.group;
}

/** The tenant mapper and one claim-to-role mapper per group mapping, re-applied at every sign-in (FORCE). */
export function oidcMappers(source: OidcSourceRow, mappings: readonly IdentityRoleMapping[], tenantId: string): IdentityProviderMapperRepresentation[] {
  const tenant: IdentityProviderMapperRepresentation = {
    name: OWNED.tenantMapper,
    identityProviderAlias: source.alias,
    identityProviderMapper: KEYCLOAK.attributeIdpMapper,
    config: { syncMode: 'FORCE', attribute: IDENTITY_FEDERATION.tenantAttribute, 'attribute.value': tenantId },
  };
  return [
    tenant,
    ...mappings.map((m) => ({
      name: roleMapperName(m),
      identityProviderAlias: source.alias,
      identityProviderMapper: KEYCLOAK.claimToRoleMapper,
      config: { syncMode: 'FORCE', claim: source.settings.groupsClaim, 'claim.value': m.group, role: realmRoleOf(m.role) },
    })),
  ];
}

/** The realm roles each group grants. */
export function rolesByGroup(mappings: readonly IdentityRoleMapping[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of mappings) {
    const roles = out.get(m.group) ?? new Set<string>();
    roles.add(realmRoleOf(m.role));
    out.set(m.group, roles);
  }
  return out;
}

/** The redirect URI to register with a provider: Keycloak's broker endpoint for this alias, as browsers reach it. */
export function brokerRedirectUri(publicKeycloakUrl: string, realm: string, alias: string): string {
  return new URL('realms/' + encodeURIComponent(realm) + '/broker/' + encodeURIComponent(alias) + '/endpoint', baseUrl(publicKeycloakUrl)).toString();
}
