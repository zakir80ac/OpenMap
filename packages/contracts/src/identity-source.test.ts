// T-640 REQ-INT-016 (ADR-074) — identity source contract: a directory needs LDAP settings and an identity provider OIDC
// settings; Entra ID needs its directory, Okta its domain and any other provider its issuer; group-to-role mappings
// name OpenMap's people roles only; the issuer each vendor's settings name (Entra ID v2.0 in the public and a national
// cloud, Okta org and custom authorization servers, a generic issuer); vendor presets fill what is left out; aliases are
// URL-safe and carry the id.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSchema, isEnumType } from 'graphql';
import { describe, expect, it } from 'vitest';
import { ROLES } from '@openmap/constants';
import {
  IDENTITY_MAPPED_ROLES,
  IDENTITY_SOURCE_KINDS,
  IDENTITY_SOURCE_STATES,
  IDENTITY_SOURCE_VENDORS,
  discoveryUrl,
  identitySourceAlias,
  identitySourceInputSchema,
  mappedRoleOf,
  oidcIssuer,
  realmRoleOf,
  resolveLdapSettings,
  resolveOidcSettings,
  sameIssuer,
  vendorKind,
} from './identity-source.js';

const ENTRA = 'https://login.microsoftonline.com';
const ldap = {
  connectionUrl: 'ldaps://dc01.corp.example:636',
  bindDn: 'CN=svc-openmap,OU=Service,DC=corp,DC=example',
  usersDn: 'OU=People,DC=corp,DC=example',
  groupsDn: 'OU=Groups,DC=corp,DC=example',
};
const directory = { vendor: 'active_directory', name: 'Corp AD', secretRef: 'identity/corp-ad', roleMappings: [{ group: 'OpenMap Operators', role: 'operator' }], ldap } as const;

describe('identity source input', () => {
  it('accepts a directory and rejects one without, or with foreign, settings', () => {
    expect(identitySourceInputSchema.safeParse(directory).success).toBe(true);
    expect(identitySourceInputSchema.safeParse({ ...directory, ldap: null }).success).toBe(false);
    expect(identitySourceInputSchema.safeParse({ ...directory, oidc: { clientId: 'x' } }).success).toBe(false);
    expect(identitySourceInputSchema.safeParse({ ...directory, ldap: { ...ldap, connectionUrl: 'http://dc01' } }).success).toBe(false);
    expect(identitySourceInputSchema.safeParse({ ...directory, ldap: { ...ldap, syncPeriodMinutes: 1 } }).success).toBe(false);
  });

  it('needs the directory for Entra ID, the domain for Okta and the issuer for another provider', () => {
    const base = { name: 'IdP', secretRef: 'identity/idp', roleMappings: [] };
    expect(identitySourceInputSchema.safeParse({ ...base, vendor: 'entra_id', oidc: { clientId: 'app' } }).success).toBe(false);
    expect(identitySourceInputSchema.safeParse({ ...base, vendor: 'entra_id', oidc: { clientId: 'app', directoryTenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47' } }).success).toBe(true);
    expect(identitySourceInputSchema.safeParse({ ...base, vendor: 'entra_id', oidc: { clientId: 'app', directoryTenantId: 'contoso.onmicrosoft.com' } }).success).toBe(true);
    expect(identitySourceInputSchema.safeParse({ ...base, vendor: 'okta', oidc: { clientId: 'app' } }).success).toBe(false);
    expect(identitySourceInputSchema.safeParse({ ...base, vendor: 'okta', oidc: { clientId: 'app', domain: 'acme.okta.com' } }).success).toBe(true);
    expect(identitySourceInputSchema.safeParse({ ...base, vendor: 'oidc', oidc: { clientId: 'app' } }).success).toBe(false);
    expect(identitySourceInputSchema.safeParse({ ...base, vendor: 'oidc', oidc: { clientId: 'app', issuer: 'not a url' } }).success).toBe(false);
    expect(identitySourceInputSchema.safeParse({ ...base, vendor: 'oidc', oidc: { clientId: 'app', issuer: 'https://sso.corp.example/realms/staff' } }).success).toBe(true);
  });

  it('maps groups to people roles only, each pair once', () => {
    expect(identitySourceInputSchema.safeParse({ ...directory, roleMappings: [{ group: 'nodes', role: 'node' }] }).success).toBe(false);
    expect(identitySourceInputSchema.safeParse({ ...directory, roleMappings: [{ group: 'ops', role: 'operator' }, { group: 'ops', role: 'operator' }] }).success).toBe(false);
    expect(identitySourceInputSchema.safeParse({ ...directory, roleMappings: [{ group: 'ops', role: 'operator' }, { group: 'ops', role: 'auditor' }] }).success).toBe(true);
    expect(realmRoleOf('operator')).toBe(ROLES.operator);
    expect(mappedRoleOf(ROLES.auditor)).toBe('auditor');
    expect(mappedRoleOf(ROLES.node)).toBeNull();
    expect(mappedRoleOf('offline_access')).toBeNull();
  });
});

describe('issuers and presets', () => {
  const none = { issuer: null, directoryTenantId: null, domain: null, authorizationServerId: null };

  it('derives the Entra ID v2.0 issuer, in the public cloud and a national one', () => {
    expect(oidcIssuer('entra_id', { ...none, directoryTenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47' }, ENTRA)).toBe(
      'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0',
    );
    expect(oidcIssuer('entra_id', { ...none, directoryTenantId: 'contoso.us' }, 'https://login.microsoftonline.us/')).toBe('https://login.microsoftonline.us/contoso.us/v2.0');
  });

  it('derives Okta org and custom authorization server issuers', () => {
    expect(oidcIssuer('okta', { ...none, domain: 'Acme.okta.com' }, ENTRA)).toBe('https://acme.okta.com');
    expect(oidcIssuer('okta', { ...none, domain: 'acme.okta.com', authorizationServerId: 'default' }, ENTRA)).toBe('https://acme.okta.com/oauth2/default');
  });

  it('keeps a generic issuer and builds its discovery URL', () => {
    expect(oidcIssuer('oidc', { ...none, issuer: 'https://sso.corp.example/realms/staff/' }, ENTRA)).toBe('https://sso.corp.example/realms/staff');
    expect(discoveryUrl('https://acme.okta.com/oauth2/default')).toBe('https://acme.okta.com/oauth2/default/.well-known/openid-configuration');
    expect(sameIssuer('https://acme.okta.com/', 'https://acme.okta.com')).toBe(true);
    expect(sameIssuer('https://acme.okta.com/oauth2/default', 'https://acme.okta.com')).toBe(false);
  });

  it('fills vendor presets: Okta asks for the groups scope, AD signs in with sAMAccountName', () => {
    const okta = resolveOidcSettings('okta', { ...none, domain: 'acme.okta.com', clientId: 'app', scopes: null, groupsClaim: null }, ENTRA);
    expect(okta).toMatchObject({ issuer: 'https://acme.okta.com', scopes: 'openid profile email groups', groupsClaim: 'groups', directoryTenantId: null });
    const entra = resolveOidcSettings('entra_id', { ...none, directoryTenantId: 'contoso.onmicrosoft.com', clientId: 'app', scopes: null, groupsClaim: 'roles' }, ENTRA);
    expect(entra).toMatchObject({ scopes: 'openid profile email', groupsClaim: 'roles', domain: null });
    const parsed = identitySourceInputSchema.parse(directory);
    expect(parsed.ldap).toBeDefined();
    if (parsed.ldap === null || parsed.ldap === undefined) return;
    expect(resolveLdapSettings('active_directory', parsed.ldap)).toEqual({ ...ldap, startTls: false, userFilter: null, usernameAttribute: 'sAMAccountName', syncPeriodMinutes: null });
    expect(resolveLdapSettings('ldap', { ...parsed.ldap, connectionUrl: 'ldap://ldap.lab:389/' }).usernameAttribute).toBe('uid');
    expect(resolveLdapSettings('ldap', { ...parsed.ldap, connectionUrl: 'ldap://ldap.lab:389/' }).connectionUrl).toBe('ldap://ldap.lab:389');
  });

  it('mirrors its enumerations in the GraphQL contract', () => {
    const schema = buildSchema(readFileSync(fileURLToPath(new URL('../graphql/schema.graphql', import.meta.url)), 'utf8'));
    const values = (name: string): string[] => {
      const type = schema.getType(name);
      return isEnumType(type) ? type.getValues().map((v) => v.name) : [];
    };
    expect(values('IdentitySourceKind')).toEqual([...IDENTITY_SOURCE_KINDS]);
    expect(values('IdentitySourceVendor')).toEqual([...IDENTITY_SOURCE_VENDORS]);
    expect(values('IdentitySourceState')).toEqual([...IDENTITY_SOURCE_STATES]);
    expect(values('IdentityMappedRole')).toEqual([...IDENTITY_MAPPED_ROLES]);
  });

  it('makes URL-safe aliases that carry the id', () => {
    expect(identitySourceAlias('Corp AD (EMEA)', '3f2b9c1e-0000-4000-8000-000000000000')).toBe('openmap-corp-ad-emea-3f2b9c1e');
    expect(identitySourceAlias('دليل', 'ABCDEF12-0000-4000-8000-000000000000')).toBe('openmap-abcdef12');
    expect(vendorKind('okta')).toBe('oidc');
    expect(vendorKind('active_directory')).toBe('ldap');
  });
});
