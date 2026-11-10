# ADR-074 — Identity federation: directories and OpenID Connect providers applied to Keycloak by the API

Status: Accepted · Date: 2026-11-10 · Tracker: REQ-INT-016 · Contracts: GraphQL 1.46.0

## Context

CAPABILITY-MAP.md §"Integrations" asks for Device42's identity parity: people sign in with their Active Directory,
Microsoft Entra ID or Okta accounts. OpenMap signs everyone in through Keycloak (realm `openmap`, REQ-SEC-009), whose
realm roles (`openmap-admin`, `-operator`, `-analyst`, `-auditor`) and `tenant` attribute the API reads from the token
(REQ-CORE-012). Keycloak already federates LDAP directories and brokers OpenID Connect providers; what was missing is
a way for a tenant's administrator to set them up from OpenMap, without Keycloak's admin console and without a secret
ever stored in OpenMap.

## Decision

1. **Identity sources are OpenMap records applied to Keycloak.** Table `identity_sources` (migration 0051) keeps, per
   tenant, the vendor (`active_directory`, `ldap`, `entra_id`, `okta`, `oidc`), the non-secret settings with the vendor
   presets filled in, the group-to-role mappings, an OpenBao reference (`secretRef`: field `password` for a directory's
   bind password, `clientSecret` for a provider's client secret, e.g. a Setup `oauth_client` credential set), and the
   outcome of the last apply, test and sync. Every save, sync and removal writes an audit event through the outbox. The
   API then applies the source through Keycloak's admin REST API to the federation realm (`IDENTITY_FEDERATION_REALM`,
   default `KEYCLOAK_REALM`); a failed apply is kept with state `error` and Keycloak's reason, so the administrator sees
   it and saves again.
2. **Directories: LDAP user storage, read-only, users imported.** One `ldap` component named after the source's alias
   with Keycloak's vendor presets (AD: `sAMAccountName`, `objectGUID`, `person, organizationalPerson, user`; other LDAP:
   `uid`, `entryUUID`, `inetOrgPerson, organizationalPerson`), edit mode `READ_ONLY`, optional full sync every
   `syncPeriodMinutes`. Two mappers of OpenMap's: `openmap-groups` (`group-ldap-mapper`, groups imported below the
   Keycloak group `/<alias>`, membership by the `member` DN) and `openmap-tenant` (every user carries the tenant id in
   the `tenant` attribute the realm's token mapper reads). **Group mappings are realm roles on the groups below
   `/<alias>`**: OpenMap creates `/<alias>/<group>` before the first sync (Keycloak's group import reuses a group of the
   same name) and keeps exactly the mapped OpenMap roles on each, so a remap takes effect at the next sign-in without a
   sync. "Sync now" imports the groups, then the users (Keycloak's `fedToKeycloak` and `triggerFullSync`).
3. **Providers: OIDC brokering.** One `oidc` identity provider per source: endpoints read by Keycloak from the issuer's
   discovery document (`identity-provider/import-config`, so the fetch happens from where Keycloak brokers, and the
   document must name the expected issuer), authorization code with PKCE S256, the client secret posted, signatures
   checked against the JWKS, sync mode FORCE. Mappers: `openmap-tenant` (`hardcoded-attribute-idp-mapper`) and one
   `openmap-role:<role>:<group>` (`oidc-role-idp-mapper`) per mapping, matching the value in the groups claim. Entra ID
   and Okta are OIDC configurations, not separate integrations: Entra ID's issuer is
   `<IDENTITY_ENTRA_AUTHORITY_URL>/<directory>/v2.0` (national clouds change the authority), groups arrive as object ids
   in `groups`; Okta's is `https://<domain>` or `https://<domain>/oauth2/<server>`, with the `groups` scope asked for.
   The view returns the redirect URI to register with the provider (`…/realms/<realm>/broker/<alias>/endpoint`).
4. **Tests are Keycloak's.** "Test connection" runs Keycloak's `testLDAPConnection` (connect and bind with the stored
   bind password) or its discovery read, never a probe from the API, so the result reflects what Keycloak will reach.
5. **Ownership and isolation.** Every object OpenMap creates carries `openmap` in its name; the alias is
   `openmap-<name slug>-<8 characters of the source id>`, unique across the tenants sharing a realm and fixed once
   created (a provider's redirect URI contains it). OpenMap updates and deletes only those objects. Removing a source
   deletes its component (Keycloak removes the users it imported) and its group tree, or its identity provider.
6. **Keycloak admin access from config only.** The API signs in with the client-credentials grant of
   `KEYCLOAK_ADMIN_CLIENT_ID` when `KEYCLOAK_ADMIN_CLIENT_SECRET` is set (a service account holding realm-management
   `manage-realm`, `manage-users`, `view-realm`: the production choice), else with the password grant of
   `KEYCLOAK_ADMIN` through `admin-cli`, both in `KEYCLOAK_ADMIN_REALM`. Only the API container receives them.
7. **Air gap.** Entra ID and Okta are internet services: the airgap profile refuses them (save and test). Active
   Directory, other LDAP and self-hosted OpenID Connect providers work, because Keycloak and the directory are on the
   customer's network; no call leaves it.
8. **GraphQL 1.46.0** (additions only): `identitySources`, `upsertIdentitySource`, `testIdentitySource`,
   `syncIdentitySource`, `removeIdentitySource`, administrators only. Observability: spans `identity.source.apply`,
   `.test`, `.sync`, `.remove`; counters `openmap_identity_source_operations_total{op,kind,outcome}` and
   `openmap_identity_sync_users_total{result}`.

## Consequences

- Keycloak keeps a copy of the bind password and client secret (it needs them to bind and to redeem codes); OpenMap
  re-sends them from OpenBao at every apply, so rotating the OpenBao record and saving the source rotates Keycloak's.
  Keycloak's vault SPI could read OpenBao directly; that is a deployment change for later and needs no contract change.
- Removing a provider's group mapping deletes its mapper but does not take the role from people who signed in while it
  existed (Keycloak's FORCE re-evaluates only existing mappers); removing the role is done in Keycloak or by removing
  and re-adding the source. Directory mappings have no such gap (roles sit on groups).
- Federated users exist in Keycloak only; OpenMap still learns a person from the token (no user table).
- The integration test runs against throwaway realms and a real OpenLDAP; live Entra ID and Okta tenants are not part of
  CI, so their mapping is covered by unit tests (issuer, scopes, claims, endpoints).
