# ADR-041 — SaaS inventory read model

Status: Accepted and implemented (REQ-CMDB-022, 2026-11-07) · Date: 2026-11-07 · Tracker: REQ-CMDB-022

## Context

The SaaS collector already reports tenants (`saas_tenant`), subscriptions (`saas_application` licensed_by the tenant,
member_of the vendor) with seats and terms, but nothing read them as an inventory, and the synthetic estate had no
SaaS layer, so the dev stack could not show one.

## Decision

1. GraphQL 1.18.0 adds a read model, `saasInventory`, over the existing CI types: per tenant the users, active users,
   SSO applications and domains; per subscription the seats bought, assigned and unused, underuse below
   `SAAS.underusedPercent`, the renewal date and state (renewing inside `SAAS.renewalHorizonDays`, lapsed), and the
   `communicates_with` data flows from the organisation's applications with their data class. No new CI or
   relationship type.
2. The synthetic estate generates SaaS tenants as the collector reports them, on a stream appended last so the rest
   of the estate is unchanged.
3. The console shows a SaaS screen under Discover.

## Consequences

- SaaS spend (unused seats), renewals and data exposure are visible from discovery.
- Closing REQ-CMDB-022 still needs recorded responses from real tenants (risk R-004).
