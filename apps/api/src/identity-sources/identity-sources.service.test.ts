// T-643 REQ-INT-016 (ADR-074) — identity sources in the air-gap profile and as the GraphQL view. The airgap profile
// refuses Entra ID and Okta (internet services) and keeps Active Directory, other LDAP and self-hosted OpenID Connect;
// a stored source reads back with its kind, its settings and, for a provider, the redirect URI to register with it
// (Keycloak's broker endpoint as browsers reach it, in the federation realm); unknown roles in stored mappings drop out.
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '@openmap/config';
import { IDENTITY_SOURCE_VENDORS } from '@openmap/contracts';
import type { PrismaService } from '../db/prisma.service.js';
import type { SecretsService } from '../integrations/secrets.service.js';
import type { MetricsService } from '../metrics/metrics.service.js';
import type { OutboxService } from '../outbox/outbox.service.js';
import { IdentitySourcesService, assertVendorAllowed } from './identity-sources.service.js';
import { KeycloakAdminClient } from './keycloak-admin.client.js';

describe('identity sources', () => {
  it('refuses internet identity services in the airgap profile only', () => {
    for (const vendor of IDENTITY_SOURCE_VENDORS) expect(() => { assertVendorAllowed(vendor, 'single-node'); }).not.toThrow();
    expect(() => { assertVendorAllowed('entra_id', 'airgap'); }).toThrow(ForbiddenException);
    expect(() => { assertVendorAllowed('okta', 'airgap'); }).toThrow(/airgap profile/u);
    for (const vendor of ['active_directory', 'ldap', 'oidc'] as const) expect(() => { assertVendorAllowed(vendor, 'airgap'); }).not.toThrow();
  });

  it('reads a stored provider back with its redirect URI and a directory with its settings', () => {
    const env = loadEnv({ PUBLIC_KEYCLOAK_URL: 'https://sso.corp.example', KEYCLOAK_REALM: 'openmap', IDENTITY_FEDERATION_REALM: 'staff' });
    const service = new IdentitySourcesService(
      {} as PrismaService,
      {} as OutboxService,
      {} as MetricsService,
      {} as SecretsService,
      new KeycloakAdminClient(env),
      env,
    );
    const at = new Date('2026-11-10T08:00:00.000Z');
    const base = { tenantId: 't', enabled: true, secretRef: 'identity/x', state: 'applied', keycloakId: 'k', lastError: null, lastTestAt: null, lastTestOk: null, lastTestMessage: null, lastSyncAt: null, lastSync: null, updatedBy: 'admin', createdAt: at, updatedAt: at };
    const okta = service.view({
      ...base,
      id: 'a',
      kind: 'oidc',
      vendor: 'okta',
      name: 'Okta',
      alias: 'openmap-okta-12345678',
      settings: { issuer: 'https://acme.okta.com', directoryTenantId: null, domain: 'acme.okta.com', authorizationServerId: null, clientId: '0oa1', scopes: 'openid profile email groups', groupsClaim: 'groups' },
      roleMappings: [{ group: 'OpenMap Ops', role: 'operator' }, { group: 'Nodes', role: 'node' }],
    });
    expect(okta).toMatchObject({ kind: 'oidc', ldap: null, state: 'applied', roleMappings: [{ group: 'OpenMap Ops', role: 'operator' }] });
    expect(okta.oidc?.redirectUri).toBe('https://sso.corp.example/realms/staff/broker/openmap-okta-12345678/endpoint');
    const ad = service.view({
      ...base,
      id: 'b',
      kind: 'ldap',
      vendor: 'active_directory',
      name: 'AD',
      alias: 'openmap-ad-12345678',
      state: 'whatever',
      settings: { connectionUrl: 'ldaps://dc01:636', startTls: false, bindDn: 'cn=x', usersDn: 'ou=p', userFilter: null, groupsDn: 'ou=g', usernameAttribute: 'sAMAccountName', syncPeriodMinutes: 60 },
      roleMappings: [],
      lastTestAt: at,
      lastTestOk: true,
      lastTestMessage: 'bound',
      lastSyncAt: at,
      lastSync: { added: 2, updated: 0, removed: 0, failed: 0, groups: 1, message: '2 imported users' },
    });
    expect(ad).toMatchObject({ kind: 'ldap', oidc: null, state: 'pending', lastTest: { ok: true, message: 'bound', at }, lastSync: { added: 2, groups: 1, at } });
    expect(ad.ldap?.usernameAttribute).toBe('sAMAccountName');
  });
});
