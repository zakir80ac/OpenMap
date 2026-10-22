# ADR-012 — Integrations detail, embedded analytics and rack placement in the GraphQL contract (0.4.0)

Status: Accepted · Date: 2026-10-22 · Tracker: REQ-UI-009, REQ-UI-010, REQ-UI-011, REQ-UI-014, REQ-UI-017, REQ-UI-018

## Context

Six navigation entries (assets, IPAM, DCIM, integrations, analytics, assistant) pointed at routes that did not exist.
Building them against the live stack exposed three gaps in the API: an integration could be listed but not inspected
(no configuration, mappings or deliveries), analytics had no way to hand the browser a Superset session scoped to
the tenant, and racks carried no placement in the room (the estate places racks in rows and rows in rooms). IPAM and
DCIM also read attribute names the collectors and the synthetic estate never emit (`cidr` from attributes instead of
identity; `units`, `startUnit`, `power_feed` instead of `heightU`, `uPosition` and PDUs located in the rack).

## Decision

Minor bump 0.3.0 → 0.4.0: `IntegrationDetail`, `IntegrationDelivery`, `Query.integration`,
`Query.integrationDeliveries` (operator and above), `AnalyticsEmbed` with `Query.analyticsEmbed` (analyst and above),
and `Rack.row` / `Rack.room`. The analytics query provisions the estate dashboard in Superset once (database,
datasets, charts, dashboard, embedding, guest-role permissions) through Superset's own REST API and mints a
five-minute guest token whose row-level-security clause pins `tenant_id`; the console embeds it with
`@superset-ui/embedded-sdk`, the SDK the Superset project ships for exactly this (Apache-2.0, part of the Superset
component already in the stack). The attribute conventions the DCIM path reads now live in
`packages/contracts` (`DCIM_ATTRIBUTES`) so collectors, the synthetic estate and the API agree; IPAM reads `cidr`
and `vrfRef` from the identity, as the contract's identity keys say.

## Consequences

Every sidebar entry resolves to a working screen on the real stack. Superset becomes a runtime dependency of the
analytics screen only; the API degrades to an explicit error when it is unreachable and the rest of the console is
unaffected. Chart definitions are code in the API, versioned with it; changing them re-provisions on next start.
