# ADR-014 — CI short codes in the contract: `Ci.code`, `setCiCode`, uniqueness in Postgres (GraphQL 0.6.0)

Status: Accepted · Date: 2026-11-01 · Tracker: REQ-CMDB-037

## Context

Every CI carries a short code (`ciCode()` in `packages/contracts`: a layer prefix such as `NET` or `SRV`, a dash and a
slug of the name) that the console prints on cards and people say aloud in incidents. The reconciler generated it and
Postgres stored it, but the contract never exposed it, the console derived its own copy from the name, and nothing
kept it unique: the scale-0.05 estate held 499 groups of duplicate codes, including every IP address collapsing to
`NET-10` because the slug dropped everything after the first dot as if it were a domain suffix.

## Decision

1. `ciCode()` drops a dotted tail only when it contains a letter (a domain suffix); `10.0.0.1` becomes `NET-10-0-0-1`,
   `PostgreSQL 16.4` becomes `APP-POSTGRESQL-16-4`. The accepted shape is published as `CI_CODE_PATTERN`.
2. Postgres owns uniqueness (migration `0010_ci_code_unique`): a `BEFORE INSERT OR UPDATE OF code` trigger appends
   the next free numeric suffix when a current row of the tenant already carries the code (`SRV-ESX-01`,
   `SRV-ESX-01-2`, …), existing duplicates are renumbered once in `validFrom` order, and a partial unique index on
   `("tenantId", code) WHERE "validTo" IS NULL` guarantees the invariant. Row-level BEFORE triggers see rows inserted
   earlier by the same statement, so the reconciler's array-based batch inserts stay single statements. The reconciler
   reads the stored codes back after the insert so the outbox events (and therefore Memgraph and Meilisearch) carry the
   code Postgres kept.
3. Minor bump 0.5.0 → 0.6.0: `Ci.code: String!` (the stored code, or `ciCode()` of the row for data written before
   the column was filled) and `Mutation.setCiCode(ciId, code)` for operators. The API validates the pattern, upper-cases
   the input, refuses a code another current CI of the tenant holds (409), and emits `openmap.ci.updated` with
   `changed: ['code']` so every store follows; the audit log records the change like every other mutation.

## Consequences

The console shows the stored code on the CI detail header (editable for operators), on CMDB rows and in search hits
instead of deriving it; `codeFor()` remains only as the fallback label for rows older than the column. Codes already
spoken in incidents keep their value: the migration renames only duplicates, and only the later ones.
