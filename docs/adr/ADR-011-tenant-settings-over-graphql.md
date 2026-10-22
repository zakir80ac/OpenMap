# ADR-011 — Tenant settings are read and changed through GraphQL (contract 0.3.0)

Status: Accepted · Date: 2026-10-22 · Tracker: REQ-UI-019, REQ-CORE-012

## Context

`packages/config` defines the tenant settings schema (locale, time zone, discovery interval, history and audit
retention, stale threshold, assistant and outbound-integration switches) and `apps/api` stores them in
`tenant_settings`, but nothing exposed them: the Settings screen showed identity and the audit log only, and the
values could be changed only by editing the table. CLAUDE.md §1 puts every per-tenant value in the database behind
validated settings, which implies an administrator can see and change them from the console.

## Decision

Add `TenantSettings`, `TenantSettingsInput`, `Query.tenantSettings` and `Mutation.updateTenantSettings` to the GraphQL
contract (minor bump 0.2.0 → 0.3.0; `pnpm contracts:check` accepts it). Every signed-in role reads the settings; only
`openmap-admin` changes them. The input is partial — omitted fields keep their value — and is validated against the
same zod schema the config package owns, so the API cannot persist a value the services would refuse to load. The
mutation is audited like every other through the global interceptor; it writes a single Postgres row and emits no
domain event, because no other store derives from these values at write time (ClickHouse retention follows the
default at migration time; a per-tenant TTL change is a later migration concern recorded in the tracker).

## Consequences

The Settings screen gains an editor (read-only for non-administrators). Services that already consume
`TenantSettingsService` (assistant, integrations) pick up changes on their next read. Changing the shape of a setting
is a contract change again: schema, zod schema and Prisma column move together with a tracker row.
