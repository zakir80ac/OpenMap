# OpenMap frozen contracts

Status: **frozen** (REQ-CORE-001…006 Done on 2026-10-22). The contracts were drafted from CLAUDE.md §0, the approved design canvas and docs/CAPABILITY-MAP.md while docs/SPEC.md is pending (ADR-002); when SPEC.md arrives, differences are reconciled as ADRs. Any change needs an ADR, a version bump here, and a tracker row. `pnpm contracts:check` (CI) rejects a GraphQL schema change without the matching bump: additions need a minor bump, breaking changes a major one.

| Contract | File | Version | Consumers |
| --- | --- | --- | --- |
| CI | `packages/contracts/src/ci.ts` → `schemas/ci.schema.json`, `observed-ci`, `relationship`, `observed-relationship` | 0.1.0 | reconciler, api, collectors (Go via JSON Schema), console |
| Collector | `packages/contracts/src/collector.ts` → `collector-manifest`, `collector-job`, `collector-result` | 0.1.0 | apps/node (Go), apps/collectors (Go), scheduler, reconciler |
| Event | `packages/contracts/src/event.ts` → `event-envelope`, `outbox-record` | 0.1.0 | every service; outbox subscribers; integrations |
| GraphQL | `packages/contracts/graphql/schema.graphql` | 0.6.0 (ADR-010 `auditLog`; ADR-011 tenant settings; ADR-012 integrations, analytics, rack placement; ADR-013 `software`, `vulnerabilitySummaries`, `vulnerability`; ADR-014 `Ci.code`, `setCiCode`) | apps/api (Mercurius), apps/console, Terraform provider |
| Asset | `packages/contracts/src/asset.ts` → `asset-record`, `infra-plan`, `support-contract`, `vendor-contact` | 0.1.0 | api, console, warranty integrations |
| Impact | `packages/contracts/src/impact.ts` → `impact-scenario`, `impact-simulation` | 0.1.0 | bsm-engine, api, console, assistant |
| Integration | `packages/contracts/src/integration.ts` → `integration-config`, `integration-delivery`, `security-alert` | 0.1.0 | api, bsm-engine, integration adapters |

## Principles

1. **One shape everywhere.** zod is the source; JSON Schema is emitted for Go and external tools; GraphQL mirrors the same enums (the test suite asserts `CiLayer` equals `CI_LAYERS`).
2. **Identity, not ids, from collectors.** Collectors emit `ObservedCi` with identity keys; the reconciler assigns ids. Collectors never see stored ids or secrets.
3. **Bitemporal by default.** Every stored CI and relationship carries `validFrom`/`validTo`; time travel is a read parameter (`asOf`), never a separate store.
4. **Layers are derived, then owned.** `layer = userLabel.layer ?? CI_TYPE_LAYER[type]`. Labelling an unknown CI promotes it; the event `openmap.ci.labelled` is emitted.
5. **Every cross-store write is an event.** The outbox record names pending targets; nothing writes to Memgraph, ClickHouse or Meilisearch directly.
6. **Integrations are data.** Vendors are an enum so the adapter set is explicit; adding a vendor is a tracker row, not a contract bump. Endpoints and credentials live in config and OpenBao.

## Versioning

Semantic versions per contract. Minor bumps add optional fields or enum members; major bumps change or remove. The collector contract version is carried in every job and result so mixed-version nodes are detected, never guessed.

## Change log

| Date | Contract | Change | ADR |
| --- | --- | --- | --- |
| 2026-10-22 | all | Initial 0.1.0 drafts | ADR-002 |
| 2026-10-22 | ci | Twelve-layer model, user labels, OS and SaaS types | ADR-004 |
| 2026-10-22 | asset | Infrastructure plans replace purchase orders | ADR-005 |
| 2026-10-22 | graphql, event | 0.2.0: `auditLog` query, AuditEntry/AuditConnection; `openmap.audit.action` event | ADR-010 |
| 2026-10-22 | graphql | 0.3.0: `TenantSettings`, `tenantSettings` query, `updateTenantSettings` mutation | ADR-011 |
| 2026-10-22 | graphql | 0.4.0: `IntegrationDetail`, `IntegrationDelivery`, `AnalyticsEmbed`, `Rack.row`/`Rack.room`; queries `integration`, `integrationDeliveries`, `analyticsEmbed` | ADR-012 |
| 2026-11-01 | graphql | 0.5.0: `SoftwareProduct`, `LicenceSummary`, `VulnerabilitySummary`, `VulnerabilityDetail`; queries `software`, `vulnerabilitySummaries`, `vulnerability` | ADR-013 |
| 2026-11-01 | graphql | 0.6.0: `Ci.code`; mutation `setCiCode` | ADR-014 |
| 2026-10-22 | all | Frozen; Go view checked against the emitted JSON Schemas (T-093/T-094), GraphQL bump check in CI (T-092) | ADR-002 |
