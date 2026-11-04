# ADR-017 — Initial setup: organization, sites, connectivity, Nodes and credentials, integrations, generate (GraphQL 0.9.0)

Status: Accepted · Date: 2026-11-04 · Tracker: REQ-UI-020, REQ-UI-024

## Context

A fresh deployment had no way in. Migration 0005 seeds a bootstrap organization and a `default` tenant, the contract
describes six onboarding steps (`ONBOARDING_STEPS`, `onboardingSchema`) and the `onboarding_states` table exists, but
no API or screen used them: a Discovery Node could only be registered from the scheduler's command line, sweeps are
planned from subnet CIs that nothing could create by hand, and credentials had to be put into OpenBao out of band.
Syed's verdict was that this made the product vaporware. The wizard must be real on every step, not a form that
collects text for later.

## Decision

GraphQL 0.9.0 adds `onboarding` and ten administrator mutations; each is a write the rest of the product consumes:

1. **Organization.** `updateOrganization` renames the bootstrap organization (industry, time zone, default locale,
   regulatory scope, air-gap flag) and manages business units: an existing unit renames its tenant, a new one creates
   a tenant with a slug derived from its name (the directory resolves Keycloak tenant claims by slug). The tenant the
   administrator is signed in to is always listed, with or without a business unit row.
2. **Sites.** `upsertSite` writes the site row (new facility columns, migration 0011) and creates or updates the site
   CI through the outbox (`type: site`, identity `{ code }`, attributes as the estate generator records them), so
   Memgraph, ClickHouse and Meilisearch follow and later discovery reconciles onto the same identity key. The code is
   the CI's identity and cannot change. `removeSite` retires the CI and refuses while a Node or a link references it.
3. **Connectivity.** `upsertSiteLink` creates a `site_link` CI `connected_to` both site CIs (ends A and Z).
4. **Nodes and credentials.** `registerNode` mints the one-time enrolment token exactly as the scheduler's
   `node-register` did (SHA-256 digest stored, token returned once with the scheduler URL and site code) and the
   wizard prints the `openmap-node enrol` command from `DISCOVERY_NODE_ENV`. `saveCredentialSet` validates the fields
   against `CREDENTIAL_FIELDS` (the names the Go collectors read, now in the collector contract), writes the record to
   OpenBao KV v2 under the reference and keeps only the reference in `onboarding_states.credentialRefs`; the API never
   returns a value (`CredentialSet.fields` lists names) and the audit interceptor redacts them. `addDiscoveryScope`
   creates a subnet CI `located_in` the site CI with the credential reference and type as scope attributes, so the
   planner (ADR-015) turns it into jobs for the site's Node; the same CIDR again updates instead of duplicating.
5. **Integrations.** The Integrations screen's editor is embedded; the step is optional.
6. **Generate.** `generateTwin` makes sure every site and link has its CI, records `generatedAt`, marks all steps
   complete and runs the first sweep (`runDiscovery`), whose progress the wizard follows. With no online Node the
   sweep is planned and waits for enrolment.

The console gains `/setup` (first navigation group, every role reads it, administrators edit) and a dashboard call to
action until the twin is generated. The CI repository gains `create`, `retire` and `findCurrentByIdentity` with the
reconciler's identity key convention; the secrets service gains `write` and `describe`.

## Consequences

A fresh install is set up from the browser alone: the CLI registration remains for automation. Credentials cross the
API process once, from the request to the vault. Tenants created for business units need their users' tenant claims
set in the identity provider, which stays an administrator's task outside OpenMap (REQ-SEC-009). The GraphQL
`SiteKind` and `OnboardingStep` enums mirror the contract and are asserted by the contract tests.
