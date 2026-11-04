# Initial setup wizard (REQ-UI-020, REQ-UI-024, ADR-017)

Captured 2026-11-04 on the dev compose stack (API and console images rebuilt from the commit that carries this file).

## What a fresh deployment can do now

Before: migration 0005 seeds a bootstrap organization and the `default` tenant, but a Discovery Node could only be
registered from the scheduler's command line, sweeps are planned from subnet CIs nothing could create by hand, and
credentials had to be put into OpenBao out of band. After: `/setup` walks an administrator through six steps, each a
real write.

| Step | Mutation | What it writes |
| --- | --- | --- |
| Organization | `updateOrganization` | organization row; business units rename their tenant or create a new tenant with a derived slug |
| Sites | `upsertSite`, `removeSite` | site row (facility columns, migration 0011) and the site CI through the outbox; removal retires the CI and refuses while a Node or link references the site |
| Connectivity | `upsertSiteLink`, `removeSiteLink` | link row and a `site_link` CI `connected_to` both site CIs |
| Nodes and credentials | `registerNode`, `saveCredentialSet`, `addDiscoveryScope` | pending Node with the SHA-256 of a one-time token (the token and the `openmap-node enrol` command are shown once); credential set written to OpenBao KV v2 (the API creates the `openmap` mount on first use), reference kept; subnet CI `located_in` the site with the credential reference as scope attributes |
| Integrations | `upsertIntegration` (existing editor) | optional |
| Generate | `generateTwin` | every site and link has its CI, `generatedAt` recorded, all steps complete, first sweep planned |

## API integration test (T-118, `apps/api/src/api.integration.test.ts`)

`20 passed` against the compose stack. The setup test: operator token refused on `generateTwin`; organization renamed
with one existing and one new business unit (`retail-banking` slug); site RYD created with its CI (`identityKey`
`ryd`, provenance `api`, one `openmap.ci.created` outbox row), duplicate code refused, code change refused, facility
update keeps the CI, a cloud region without provider refused; DWDM link RYD–DMM with a `site_link` CI and two
`connected_to` relationships, self-link refused; `node-ryd-it-01` pending with the digest of the returned 64-hex
token; credential `it/snmp-<tenant>` read back from OpenBao as `{ type, community }`, a wrong field refused, the
audit row carries no value; scope `10.77.0.0/24` at RYD with the credential, the same CIDR again updates the one CI;
`setOnboardingStep` and `generateTwin` (six completed steps, a first sweep id); removal of a site with a Node refused,
link and empty site removed with their CIs retired.

## Console

- Unit (T-116, `SetupView.test.tsx`): the stepper has six steps; the organization form sends the kept tenant and a
  new unit; a site is added and its CI code appears; a Node registration shows the token and the exact enrol command
  (`OPENMAP_ENROL_TOKEN=… OPENMAP_SCHEDULER_URL=… OPENMAP_NODE_ID=node-ryd-01 OPENMAP_SITE_CODE=RYD openmap-node enrol`);
  a credential set is sent with field values and listed with names; generating shows the first sweep. en and ar.
- E2E (T-117, `e2e/setup.spec.ts`): `3 passed (11.4s)` on the rebuilt images, en and ar, against the synthetic
  tenant: organization saved, site `E2E<stamp>` added with its `FAC-` code visible, Node registered with a 64-hex
  token, credential `e2e/<stamp>` stored, scope added at the site, integrations skipped, twin generated with the first
  sweep region shown, the site found in the CMDB, and the organization name unchanged at the end.
- Screenshots: `console/setup-organization-{en,ar}.png`, `console/setup-sites-{en,ar}.png`,
  `console/setup-nodes-{en,ar}.png`, `console/setup-generate-{en,ar}.png`; the walkthrough (T-087) now captures
  `/setup` with the other screens.
- The dashboard shows a "Finish the initial setup" card until the twin is generated.

## Notes

- The dev OpenBao runs `server -dev` and mounts only `secret/`; the first credential write creates the `openmap` KV v2
  mount. A production vault with the mount pre-created is left alone (HTTP 400 "path is already in use").
- Sites that have a Node cannot be removed, so each e2e run leaves a site, a pending Node and a vault record on the
  dev stack; the synthetic tenant's twin is unaffected.
- Users of a business unit created here need the tenant claim set in the identity provider (REQ-SEC-009).
