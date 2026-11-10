// T-641 REQ-INT-016 (ADR-074) — identity sources as Keycloak representations. Active Directory and OpenLDAP become
// read-only LDAP components with their vendor's attribute presets, a periodic full sync only when asked, groups imported
// below `/<alias>` and the tenant attribute on every user; Entra ID and Okta become brokered OIDC providers whose
// endpoints, client, scopes and PKCE come from their settings and discovery document, with the tenant mapper and one
// claim-to-role mapper per group mapping. No live Entra ID or Okta is involved: these are the config mappings.
import { describe, expect, it } from 'vitest';
import { ROLES } from '@openmap/constants';
import { resolveLdapSettings, resolveOidcSettings } from '@openmap/contracts';
import {
  KEYCLOAK,
  OWNED,
  brokerRedirectUri,
  groupsPath,
  ldapComponent,
  ldapGroupMapper,
  ldapTenantMapper,
  oidcMappers,
  oidcProvider,
  roleMapperName,
  rolesByGroup,
  syncPeriodSeconds,
} from './keycloak-mapping.js';

const ENTRA = 'https://login.microsoftonline.com';
const TENANT = 'ac9a6a65-1f19-4ecf-bf16-b3a90e42cc5c';
const ldapInput = {
  connectionUrl: 'ldaps://dc01.corp.example:636',
  startTls: false,
  bindDn: 'CN=svc-openmap,OU=Service,DC=corp,DC=example',
  usersDn: 'OU=People,DC=corp,DC=example',
  userFilter: '(memberOf=CN=OpenMap,OU=Groups,DC=corp,DC=example)',
  groupsDn: 'OU=Groups,DC=corp,DC=example',
  usernameAttribute: null,
  syncPeriodMinutes: 60,
};
const none = { issuer: null, directoryTenantId: null, domain: null, authorizationServerId: null, scopes: null, groupsClaim: null };

describe('directories', () => {
  const ad = { alias: 'openmap-corp-ad-3f2b9c1e', vendor: 'active_directory' as const, enabled: true, settings: resolveLdapSettings('active_directory', ldapInput) };

  it('maps Active Directory to a read-only, importing LDAP component with the AD presets', () => {
    const rep = ldapComponent(ad, 'realm-id', 's3cret');
    expect(rep).toMatchObject({ name: ad.alias, providerId: 'ldap', providerType: KEYCLOAK.userStorageType, parentId: 'realm-id' });
    expect(rep.config).toMatchObject({
      vendor: ['ad'],
      connectionUrl: ['ldaps://dc01.corp.example:636'],
      bindDn: [ldapInput.bindDn],
      bindCredential: ['s3cret'],
      usersDn: [ldapInput.usersDn],
      customUserSearchFilter: [ldapInput.userFilter],
      usernameLDAPAttribute: ['sAMAccountName'],
      rdnLDAPAttribute: ['cn'],
      uuidLDAPAttribute: ['objectGUID'],
      userObjectClasses: ['person, organizationalPerson, user'],
      editMode: ['READ_ONLY'],
      importEnabled: ['true'],
      syncRegistrations: ['false'],
      fullSyncPeriod: ['3600'],
      changedSyncPeriod: ['-1'],
      enabled: ['true'],
      searchScope: ['2'],
    });
    for (const values of Object.values(rep.config)) expect(values).toHaveLength(1);
  });

  it('maps another LDAP to the inetOrgPerson presets, a disabled source to a disabled component, no period to none', () => {
    const settings = resolveLdapSettings('ldap', { ...ldapInput, connectionUrl: 'ldap://ldap.lab:389', userFilter: null, syncPeriodMinutes: null });
    const rep = ldapComponent({ alias: 'openmap-lab-1', vendor: 'ldap', enabled: false, settings }, 'realm-id', 'pw');
    expect(rep.config).toMatchObject({
      vendor: ['other'],
      usernameLDAPAttribute: ['uid'],
      rdnLDAPAttribute: ['uid'],
      uuidLDAPAttribute: ['entryUUID'],
      userObjectClasses: ['inetOrgPerson, organizationalPerson'],
      customUserSearchFilter: [''],
      fullSyncPeriod: ['-1'],
      enabled: ['false'],
    });
    expect(syncPeriodSeconds(null)).toBe('-1');
    expect(syncPeriodSeconds(5)).toBe('300');
  });

  it('imports groups below the source group and stamps the tenant on every user', () => {
    const groups = ldapGroupMapper(ad, 'component-id');
    expect(groups).toMatchObject({ name: OWNED.groupsMapper, providerId: 'group-ldap-mapper', providerType: KEYCLOAK.ldapMapperType, parentId: 'component-id' });
    expect(groups.config).toMatchObject({
      'groups.dn': [ldapInput.groupsDn],
      'group.object.classes': ['group'],
      'membership.ldap.attribute': ['member'],
      'membership.attribute.type': ['DN'],
      mode: ['READ_ONLY'],
      'groups.path': ['/openmap-corp-ad-3f2b9c1e'],
      'drop.non.existing.groups.during.sync': ['false'],
    });
    expect(groupsPath('openmap-x')).toBe('/openmap-x');
    expect(ldapTenantMapper('component-id', TENANT)).toEqual({
      name: OWNED.tenantMapper,
      providerId: 'hardcoded-attribute-mapper',
      providerType: KEYCLOAK.ldapMapperType,
      parentId: 'component-id',
      config: { 'user.model.attribute': ['tenant'], 'attribute.value': [TENANT] },
    });
  });

  it('collects the realm roles each group grants', () => {
    const byGroup = rolesByGroup([
      { group: 'ops', role: 'operator' },
      { group: 'ops', role: 'auditor' },
      { group: 'it-admins', role: 'admin' },
    ]);
    expect([...(byGroup.get('ops') ?? [])].sort()).toEqual([ROLES.auditor, ROLES.operator].sort());
    expect([...(byGroup.get('it-admins') ?? [])]).toEqual([ROLES.admin]);
  });
});

describe('OpenID Connect providers', () => {
  const entraSettings = resolveOidcSettings('entra_id', { ...none, directoryTenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47', clientId: 'b1e0c2a4-app' }, ENTRA);
  const entraEndpoints = {
    issuer: 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0',
    authorizationUrl: 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/oauth2/v2.0/token',
    jwksUrl: 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/discovery/v2.0/keys',
    userInfoUrl: 'https://graph.microsoft.com/oidc/userinfo',
  };
  const entra = { alias: 'openmap-entra-1a2b3c4d', name: 'Corp Entra ID', enabled: true, settings: entraSettings };

  it('brokers Entra ID with the discovered v2.0 endpoints, PKCE and the posted client secret', () => {
    const rep = oidcProvider(entra, entraEndpoints, 'client-secret-value');
    expect(rep).toMatchObject({ alias: entra.alias, displayName: 'Corp Entra ID', providerId: 'oidc', enabled: true, trustEmail: false, storeToken: false, firstBrokerLoginFlowAlias: 'first broker login' });
    expect(rep.config).toMatchObject({
      issuer: entraEndpoints.issuer,
      authorizationUrl: entraEndpoints.authorizationUrl,
      tokenUrl: entraEndpoints.tokenUrl,
      jwksUrl: entraEndpoints.jwksUrl,
      useJwksUrl: 'true',
      validateSignature: 'true',
      clientId: 'b1e0c2a4-app',
      clientSecret: 'client-secret-value',
      clientAuthMethod: 'client_secret_post',
      defaultScope: 'openid profile email',
      pkceEnabled: 'true',
      pkceMethod: 'S256',
      syncMode: 'FORCE',
    });
    expect(rep.config['logoutUrl']).toBeUndefined();
  });

  it('maps Entra group object ids and Okta group names to realm roles, with the tenant on every brokered user', () => {
    const groupId = '0c1d2e3f-4a5b-6c7d-8e9f-a0b1c2d3e4f5';
    const mappers = oidcMappers(entra, [{ group: groupId, role: 'operator' }], TENANT);
    expect(mappers).toEqual([
      { name: OWNED.tenantMapper, identityProviderAlias: entra.alias, identityProviderMapper: 'hardcoded-attribute-idp-mapper', config: { syncMode: 'FORCE', attribute: 'tenant', 'attribute.value': TENANT } },
      { name: roleMapperName({ group: groupId, role: 'operator' }), identityProviderAlias: entra.alias, identityProviderMapper: 'oidc-role-idp-mapper', config: { syncMode: 'FORCE', claim: 'groups', 'claim.value': groupId, role: ROLES.operator } },
    ]);
    const okta = { alias: 'openmap-okta-9f8e7d6c', name: 'Okta', enabled: true, settings: resolveOidcSettings('okta', { ...none, domain: 'acme.okta.com', authorizationServerId: 'default', clientId: '0oa1okta' }, ENTRA) };
    expect(okta.settings.issuer).toBe('https://acme.okta.com/oauth2/default');
    expect(oidcProvider(okta, { issuer: okta.settings.issuer, authorizationUrl: okta.settings.issuer + '/v1/authorize', tokenUrl: okta.settings.issuer + '/v1/token' }, 's').config).toMatchObject({
      defaultScope: 'openid profile email groups',
      useJwksUrl: 'false',
    });
    const oktaMappers = oidcMappers(okta, [{ group: 'OpenMap Admins', role: 'admin' }, { group: 'OpenMap Admins', role: 'auditor' }], TENANT);
    expect(oktaMappers.map((m) => m.name)).toEqual([OWNED.tenantMapper, 'openmap-role:admin:OpenMap Admins', 'openmap-role:auditor:OpenMap Admins']);
    expect(oktaMappers[2]?.config).toMatchObject({ claim: 'groups', 'claim.value': 'OpenMap Admins', role: ROLES.auditor });
  });

  it('names the broker endpoint browsers return to', () => {
    expect(brokerRedirectUri('https://sso.corp.example/', 'openmap', 'openmap-entra-1a2b3c4d')).toBe('https://sso.corp.example/realms/openmap/broker/openmap-entra-1a2b3c4d/endpoint');
  });
});
