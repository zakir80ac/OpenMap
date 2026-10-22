# ADR-002 — Contracts drafted at 0.1.0 while docs/SPEC.md is pending

Status: Accepted · Date: 2026-10-22 · Tracker: REQ-CORE-001…006, risk R-001

## Context

CLAUDE.md names docs/SPEC.md as the single source of truth and tells the first session to stop if it is missing. It was missing on 2026-10-22. Syed asked for the build to start and approved the product scope through the design canvas, the layer model, asset management and the Device42 parity map.

## Decision

Draft every contract at version 0.1.0 from three inputs: CLAUDE.md §0 scope, the approved design canvas, and docs/CAPABILITY-MAP.md. Mark them "proposed" in docs/CONTRACTS.md. Seed the tracker from the same inputs with `specSection` pointing at the capability map. When SPEC.md arrives, re-run `pnpm tracker init` (which only adds rows), reconcile differences as ADRs, and move contracts to "frozen".

## Consequences

Work on REQ-CORE-001…006 proceeds. Any later SPEC.md disagreement is an explicit, recorded change rather than a silent rewrite.
