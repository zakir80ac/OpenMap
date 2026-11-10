# Identity federation: Active Directory / LDAP, Entra ID, Okta (REQ-INT-016, ADR-074)

Captured 2026-11-10 on the dev compose stack (Keycloak 26.2, PostgreSQL TLS-only, OpenBao in server mode), from the
Windows host. Realm `openmap` and its users were not touched: every Keycloak object below lived in throwaway realms the
integration test created and deleted.

## What ran end to end

`apps/api/src/identity-sources/identity-sources.integration.test.ts` boots the whole API (AppModule) against the
compose stores, creates two realms and starts a real directory:

| Piece                  | What                                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Federation realm       | `om-itest-fed-<stamp>`: the four OpenMap realm roles, the user profile and the `tenant` / `roles` token mappers copied from `deploy/compose/keycloak/realm-openmap.json` |
| External OIDC provider | `om-itest-idp-<stamp>`: confidential client `openmap-broker`, a `groups` claim mapper, user carol in group `om-ops`                                                    |
| Directory              | `bitnamilegacy/openldap:2.6` on network `openmap_default`: alice (in `ops` and `staff`) and bob (in `staff` only), random passwords per run                          |
| Secrets                | OpenBao records `itest/identity/<stamp>/{ldap,ldap-wrong,oidc}` (`password`, `clientSecret`); deleted after the run                                                   |

Every call goes through GraphQL as a tenant administrator; the API applies the source through Keycloak's admin REST API
with `KEYCLOAK_ADMIN` from `deploy/compose/.env`.

### T-644 — a directory (LDAP user federation)

1. `upsertIdentitySource` (vendor `ldap`, `ldap://<container>:1389`, bind DN `cn=admin,dc=lab,dc=test`, users and
   groups DNs, full sync every 60 minutes, mapping `ops → operator`): state `applied`, alias
   `openmap-lab-directory-<8 hex>`, username attribute `uid` from the vendor preset. An operator's token is refused.
2. `testIdentitySource`: Keycloak's `testLDAPConnection` connected and bound ("Keycloak connected to … and bound as
   cn=admin,dc=lab,dc=test").
3. `syncIdentitySource`: 2 groups imported below `/<alias>` (`ops`, `staff`), 2 users imported.
4. Keycloak holds component `<alias>` (`vendor other`, `READ_ONLY`, `fullSyncPeriod 3600`, bind credential masked).
5. **alice signs in with her directory password** (direct grant on a probe client of the federation realm): her token
   carries `roles: [openmap-operator, …]` and `tenant: <tenant id>`. bob's token carries the tenant and no OpenMap
   role. A wrong password is refused (401).
6. Remap `ops → admin` and save: alice's next token has `openmap-admin` and no longer `openmap-operator` (no sync
   needed: roles sit on `/<alias>/ops`).
7. Point the source at the wrong bind password: the test fails with Keycloak's `AuthenticationFailure`, and
   `identitySources` shows the failed test and the last sync (2 groups).
8. `removeIdentitySource`: the component (404) and the group tree are gone, alice can no longer sign in (401), the row
   is gone. Audit events, in order: `identity_source.created`, `.synced`, `.updated`, `.updated`, `.removed`.

### T-645 — an OpenID Connect provider (brokering)

1. `upsertIdentitySource` (vendor `oidc`, issuer `http://localhost:8080/realms/om-itest-idp-<stamp>`, client
   `openmap-broker`, mapping `om-ops → operator`): state `applied`; presets `openid profile email` / `groups`; redirect
   URI `http://localhost:8080/realms/om-itest-fed-<stamp>/broker/<alias>/endpoint`.
2. `testIdentitySource`: Keycloak read the discovery document of the issuer.
3. The broker in Keycloak holds the provider's issuer, authorization, token and JWKS endpoints exactly as its discovery
   document lists them, client `openmap-broker`, `client_secret_post`, PKCE, sync mode FORCE, the secret masked; mappers
   `openmap-tenant` (tenant id) and `oidc-role-idp-mapper` (`groups` = `om-ops` → `openmap-operator`).
4. **carol signs in through the broker** (authorization-code flow driven by the test: federation realm → provider's login
   form → back through the broker endpoint → first broker login → client callback → code exchange): her token in the
   federation realm carries `preferred_username: carol`, `tenant: <tenant id>` and `openmap-operator`.
5. A wrong issuer (a realm that does not exist): saved with state `error` ("Keycloak could not read …"), test fails.
6. `removeIdentitySource`: the identity provider is gone (404).
7. `/metrics` of the API counts the runs: `openmap_identity_source_operations_total` for apply/test/sync/remove by kind
   and outcome, `openmap_identity_sync_users_total{result="added"}`.

Run: `pnpm --filter @openmap/api exec vitest run --config vitest.integration.config.ts --no-file-parallelism
src/identity-sources/identity-sources.integration.test.ts` with `deploy/compose/.env` sourced and `OPENBAO_TOKEN` from
`.local/openbao-root-token`: **2 passed** (T-644 2.1 s, T-645 0.7 s; 25 s with the API boot, the realms and the
directory container). Afterwards: realms `master` and `openmap` only, no `om-itest-*` container, no `identity_sources`
row, the OpenBao records deleted. Earlier runs in the same session failed only on Docker Desktop's port forwarding
dropping new host connections (P1001 / ECONNRESET) under load; the fixtures now come before the API boot and retry.

## Entra ID and Okta

No live Entra ID or Okta tenant is used. Both are OpenID Connect providers to Keycloak; what is specific to them is the
configuration, which the unit tests cover: Entra ID's v2.0 issuer `<IDENTITY_ENTRA_AUTHORITY_URL>/<directory>/v2.0`
(public and national clouds, directory GUID or verified domain), group object ids in `groups`; Okta's org and custom
authorization-server issuers, the `groups` scope, group names in `groups`; the broker representation built from a
discovery document (endpoints, PKCE, client authentication) and one claim-to-role mapper per mapping. The air-gap
profile refuses both (internet services) and keeps directories and self-hosted providers.

## Tests

| Test                                                                         | What it proves                                                                                                                                                                                       | Result                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `packages/contracts/src/identity-source.test.ts` (T-640)                     | input rules per vendor, people roles only, Entra ID / Okta / generic issuers, vendor presets, aliases, GraphQL enums mirror the contract                                                               | 9 passed                |
| `apps/api/src/identity-sources/keycloak-mapping.test.ts` (T-641)             | AD and OpenLDAP components, group and tenant mappers, Entra ID and Okta broker configs and mappers, redirect URI                                                                                     | 7 passed                |
| `apps/api/src/identity-sources/keycloak-admin.client.test.ts` (T-642)        | password vs client-credentials grant in the admin realm, token reuse, a refused token retried once, the federation realm, Keycloak's reason in errors, no credentials no call                         | 4 passed                |
| `apps/api/src/identity-sources/identity-sources.service.test.ts` (T-643)     | airgap refuses Entra ID and Okta only; the stored source as the GraphQL view (redirect URI in the federation realm, unknown roles dropped)                                                            | 2 passed                |
| `apps/api/src/identity-sources/identity-sources.integration.test.ts` (T-644) | the directory run above                                                                                                                                                                              | 1 passed                |
| `apps/api/src/identity-sources/identity-sources.integration.test.ts` (T-645) | the provider run above, and the Prometheus counters                                                                                                                                                  | 1 passed                |
| `apps/console/src/components/settings/IdentitySourcesCard.test.tsx` (T-646)  | the card in en and ar: states, mappings, test and sync results, redirect URI, sync only for directories; adding Okta sends OIDC settings only; the draft checked against the contract                   | 5 passed                |
| `apps/console/e2e/identity-sources.spec.ts` (T-647)                          | live stack, en and ar: add a disabled OIDC provider (Keycloak's `master` realm) from Settings, Applied with the redirect URI, Test works, remove it; screenshots `settings-identity-sources-{en,ar}.png` | written, not run here   |

Also: `pnpm guard` ok; `pnpm contracts:check` ok (GraphQL 1.46.0 against HEAD); i18n catalogues in sync (81 keys
added in en and ar); API unit suite 67 passed, console unit suite 389 passed; typecheck clean for contracts, API and
console; console lint clean for the touched files.
