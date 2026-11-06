# SaaS asset inventory (REQ-CMDB-022)

Captured 2026-11-07 on the dev compose stack.

## What changed

1. **Synthetic estate** (`tools/synth-estate/src/gen/saas.ts`, its own stream appended last so no other value moves):
   Microsoft 365, Google Workspace, Salesforce, ServiceNow and Workday tenants as the SaaS collector reports them
   (`saas_tenant` with users, active users, SSO applications and domains; `saas_application` per subscription with
   seats bought and assigned, status and term, one lapsed and several renewing within the quarter; licensed_by and
   member_of), plus `communicates_with` data flows from the bank's applications with the data class. Replayed into
   the dev estate through the reconciler (18 CIs, 32 relationships); the SaaS layer is populated for the first time.
2. **API** (GraphQL 1.18.0): `saasInventory`: tenants, subscriptions with unused seats, underuse (below
   `SAAS.underusedPercent`), days to renewal and state (renewing inside `SAAS.renewalHorizonDays`, lapsed), data flows.
3. **Console**: a SaaS screen under Discover.

The SaaS collector (Microsoft Graph, Google Admin SDK, Salesforce, ServiceNow, Workday) was already in place (T-075,
tested against in-process stand-ins). Recorded responses from real tenants are still needed for the row to close
(risk R-004): see STATE.md, Questions for Syed.

## Tests

| Id | What | Result |
| --- | --- | --- |
| T-213 | `apps/api/src/api.integration.test.ts`: a tenant with users, active users, SSO applications and domains; subscriptions soonest renewal first, lapsed and renewing, unused seats, underuse, the data flow from an internal application | 1 of 1 |
| T-214 | `apps/console/src/components/saas/SaasView.test.tsx` (en, ar): tenant summary, seats assigned of bought, underused, renews in or lapsed, data-flow links, order | 2 of 2 |
| T-215 | Playwright `apps/console/e2e/saas.spec.ts` (en, ar): the five tenants, a lapsed subscription, Microsoft 365 E3, a data flow | 2 of 2 |
| T-204 | `tools/synth-estate/src/synth.test.ts`: every layer, SaaS included, present and consistent with `CI_TYPE_LAYER` | suite 22 of 22 |

## Screenshots

- `console/saas-en.png`, `console/saas-ar.png`
