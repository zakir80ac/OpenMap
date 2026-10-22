# ADR-010 — Every mutation is audited through the outbox; the GraphQL contract gains `auditLog`

Status: proposed (REQ-SEC-005) · Date: 2026-10-22

## Context

CLAUDE.md §1 and the capability map require an immutable audit log of every change, visible in Settings.
The schema already carried an `audit_logs` table (Postgres) and an `audit_log` table (ClickHouse) and the event
type `openmap.audit.action`, but nothing wrote them, and the GraphQL contract (0.1.0, proposed) had no way to read
them.

## Decision

1. A global GraphQL interceptor in `apps/api` records every successful **mutation** as an audit entry: actor
   (Keycloak username), action (mutation field), subject (type and id of the returned object when it has one),
   details (the mutation arguments with credential-like fields redacted) and the W3C traceparent. The entry is
   written with the outbox: the `audit_logs` row and the `openmap.audit.action` event share one transaction, and
   the reconciler's dispatcher copies the event into ClickHouse `audit_log` for retention and analytics.
2. `audit_logs` is append-only at the database: a trigger refuses UPDATE and DELETE (migration 0007).
3. The GraphQL contract moves to **0.2.0** with `auditLog(...)`, readable by `openmap-auditor` and `openmap-admin`
   (auditor implies analyst, so analysts cannot read it). The console shows it on the Settings screen beside the
   signed-in identity.

## Consequences

- Writes gain one extra row and one event per mutation; both are inside the transaction the mutation already
  opened by the interceptor's own outbox transaction, so a failed mutation leaves no audit entry.
- The GraphQL version bump is recorded in docs/CONTRACTS.md; clients pin 0.2.0.
- Deleting audit rows requires dropping the trigger, which is itself a visible schema change.
