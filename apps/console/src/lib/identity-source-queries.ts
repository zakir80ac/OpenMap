// REQ-INT-016 (ADR-074) — identity sources on the Settings screen: the tenant's directories and OpenID Connect
// providers, and the mutations that save, test, sync and remove them (administrators only; the API applies each to
// Keycloak).
import { queryOptions } from '@tanstack/react-query';
import type {
  IdentityMappedRole,
  IdentitySourceInput,
  IdentitySourceKind,
  IdentitySourceState,
  IdentitySourceVendor,
} from '@openmap/contracts';
import { gql } from './graphql';

export interface IdentitySourceTest {
  ok: boolean;
  message: string;
  at: string;
}

export interface IdentitySourceSync {
  added: number;
  updated: number;
  removed: number;
  failed: number;
  groups: number;
  message: string;
  at: string;
}

export interface IdentitySourceView {
  id: string;
  kind: IdentitySourceKind;
  vendor: IdentitySourceVendor;
  name: string;
  alias: string;
  enabled: boolean;
  secretRef: string;
  ldap: {
    connectionUrl: string;
    startTls: boolean;
    bindDn: string;
    usersDn: string;
    userFilter: string | null;
    groupsDn: string;
    usernameAttribute: string;
    syncPeriodMinutes: number | null;
  } | null;
  oidc: {
    issuer: string;
    directoryTenantId: string | null;
    domain: string | null;
    authorizationServerId: string | null;
    clientId: string;
    scopes: string;
    groupsClaim: string;
    redirectUri: string;
  } | null;
  roleMappings: Array<{ group: string; role: IdentityMappedRole }>;
  state: IdentitySourceState;
  lastError: string | null;
  lastTest: IdentitySourceTest | null;
  lastSync: IdentitySourceSync | null;
}

const TEST_FIELDS = 'ok message at';
const SYNC_FIELDS = 'added updated removed failed groups message at';
const FIELDS =
  'id kind vendor name alias enabled secretRef state lastError roleMappings { group role } ' +
  'ldap { connectionUrl startTls bindDn usersDn userFilter groupsDn usernameAttribute syncPeriodMinutes } ' +
  'oidc { issuer directoryTenantId domain authorizationServerId clientId scopes groupsClaim redirectUri } ' +
  'lastTest { ' + TEST_FIELDS + ' } lastSync { ' + SYNC_FIELDS + ' }';

export const identitySourcesQueryKey = ['identity-sources'] as const;

export function identitySourcesQuery() {
  return queryOptions({
    queryKey: identitySourcesQueryKey,
    queryFn: ({ signal }) => gql<{ identitySources: IdentitySourceView[] }>('query IdentitySources { identitySources { ' + FIELDS + ' } }', {}, signal).then((d) => d.identitySources),
  });
}

export function upsertIdentitySource(id: string | null, input: IdentitySourceInput): Promise<IdentitySourceView> {
  return gql<{ upsertIdentitySource: IdentitySourceView }>(
    'mutation UpsertIdentitySource($id: UUID, $input: IdentitySourceInput!) { upsertIdentitySource(id: $id, input: $input) { ' + FIELDS + ' } }',
    { id, input },
  ).then((d) => d.upsertIdentitySource);
}

export function testIdentitySource(id: string): Promise<IdentitySourceTest> {
  return gql<{ testIdentitySource: IdentitySourceTest }>('mutation TestIdentitySource($id: UUID!) { testIdentitySource(id: $id) { ' + TEST_FIELDS + ' } }', { id }).then((d) => d.testIdentitySource);
}

export function syncIdentitySource(id: string): Promise<IdentitySourceSync> {
  return gql<{ syncIdentitySource: IdentitySourceSync }>('mutation SyncIdentitySource($id: UUID!) { syncIdentitySource(id: $id) { ' + SYNC_FIELDS + ' } }', { id }).then((d) => d.syncIdentitySource);
}

export function removeIdentitySource(id: string): Promise<boolean> {
  return gql<{ removeIdentitySource: boolean }>('mutation RemoveIdentitySource($id: UUID!) { removeIdentitySource(id: $id) }', { id }).then((d) => d.removeIdentitySource);
}
