# ADR-001 — Monorepo tooling

Status: Accepted · Date: 2026-10-22 · Tracker: REQ-CORE-007, REQ-CORE-008

## Context

CLAUDE.md §5 fixes the repository layout and §9 the coding standards. The build needs one workspace for TypeScript apps and packages, a Go workspace for the Discovery Node and collectors, and tooling that runs identically in pre-commit and CI on Windows, Linux and macOS.

## Decision

- pnpm 10 workspaces with Turborepo 2 for task orchestration and caching.
- TypeScript 5.9 `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, ESM only (`NodeNext`).
- ESLint 9 flat config with `typescript-eslint` strict type-checked rules; default exports banned except Next.js pages.
- lefthook for pre-commit (guard, tracker verify, i18n check, graphify update). Chosen over husky because it is a single static binary that behaves the same on Windows.
- Vitest for unit tests; tsx to run TypeScript CLIs without a build step.
- Go 1.23+ workspace (`go.work`) under `apps/node` and `apps/collectors`.

## Consequences

Tools run from their own package directory (`pnpm --filter … exec tsx src/cli.ts`), so they resolve the repository root as two levels up. Turborepo's `^build` dependency means packages must build before apps type-check against their `dist`.
