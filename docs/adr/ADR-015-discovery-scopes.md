# ADR-015 — Discovery scopes in the contract: `discoveryScopes`, `updateDiscoveryScope` (GraphQL 0.7.0)

Status: Accepted · Date: 2026-11-01 · Tracker: REQ-DISC-029

## Context

The scheduler's planner already honoured per-subnet exclusions, a credential set (OpenBao reference and type) and,
since this session, per-scope rate limits, all read from attributes of the subnet CI. Nothing exposed those settings,
so operators could only reach them through the generic attribute editor on the CI detail, with no validation of the
CIDRs they typed. The scope builder also read the CIDR from the subnet's attributes, while discovered subnets keep it
in the identity (the contract key): on the synthetic estate 106 of 107 subnets were invisible to a sweep.

## Decision

Minor bump 0.6.0 → 0.7.0: `DiscoveryScope` (the subnet CI, its CIDR, housing site, exclusions, credential reference
and type, concurrency and request-rate ceilings), `Query.discoveryScopes(siteId)` and
`Mutation.updateDiscoveryScope(ciId, input)` for operators. The mutation validates every exclusion with the scheduler's
own CIDR parser, the credential type against the collector contract and the limits as positive numbers, then writes the
values as subnet attributes through the existing audited, outboxed `updateAttributes` path, so Memgraph, ClickHouse and
Meilisearch follow and the audit log records who changed a scope. `null` clears a reference or a limit; omitted fields
stay. The scope builder reads the CIDR from the identity first and falls back to attributes for older rows.

## Consequences

The Discovery screen gains a scopes card (table plus inline form). Scopes remain attributes of the subnet CI rather
than a table of their own: a subnet that disappears from discovery takes its scope with it, time travel shows the
settings a sweep ran with, and no second source of truth for subnets appears. Credentials are still only references.
