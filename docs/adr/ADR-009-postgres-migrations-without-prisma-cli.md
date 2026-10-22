# ADR-009 — Postgres migrations run by `pg`, not the Prisma CLI

**Status:** Proposed (needs Syed's confirmation) · **Date:** 2026-10-22 · **Requirements:** REQ-CORE-009, REQ-INT-001, REQ-INT-002

## Context

`prisma migrate deploy` needs the Prisma CLI (a development dependency) and shells out through pnpm. Production images are built with `pnpm deploy --prod`, and air-gapped hosts have neither pnpm nor the CLI, so the migration job in the compose overlay and the Helm hook failed with `spawnSync pnpm ENOENT`.

## Decision

`packages/db/src/migrate-postgres.ts` applies `prisma/migrations/*/migration.sql` itself over the `pg` driver (MIT), in lexical order, one transaction per migration, recording each in Prisma's own `_prisma_migrations` table with the same SHA-256 checksum Prisma writes. Prisma remains the schema language and the generator of migration SQL in development (`prisma migrate diff`); it is no longer required at runtime.

## Consequences

- `pg` (and `@types/pg`) are new dependencies of `@openmap/db`; the Prisma client is unchanged.
- Development and production run identical SQL through identical code; `prisma migrate status` still reports the same applied set.
- Multi-statement migration files run as one query; a migration containing `$$`-quoted function bodies is fine, but one that needs per-statement transaction control must be split into separate migrations.
