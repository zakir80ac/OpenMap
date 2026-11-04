# OpenMap frozen contracts

Status: **frozen** (REQ-CORE-001…006 Done on 2026-10-22). The contracts were drafted from CLAUDE.md §0, the approved design canvas and docs/CAPABILITY-MAP.md while docs/SPEC.md is pending (ADR-002); when SPEC.md arrives, differences are reconciled as ADRs. Any change needs an ADR, a version bump here, and a tracker row. `pnpm contracts:check` (CI) rejects a GraphQL schema change without the matching bump: additions need a minor bump, breaking changes a major one.

| Contract | File | Version | Consumers |
| --- | --- | --- | --- |
| CI | `packages/contracts/src/ci.ts` → `schemas/ci.schema.json`, `observed-ci`, `relationship`, `observed-relationship`, `metric-sample` | 0.2.0 (ADR-016 `metricSampleSchema`, `HEALTH_STATES`, `LAYER_HEADLINE_METRIC[].metric`) | reconciler, api, collectors (Go via JSON Schema), console |
| Collector | `packages/contracts/src/collector.ts` → `collector-manifest`, `collector-job`, `collector-result` | 0.2.0 (ADR-016 `samples`) | apps/node (Go), apps/collectors (Go), scheduler, reconciler |
| Event | `packages/contracts/src/event.ts` → `event-envelope`, `outbox-record` | 0.2.0 (ADR-016 `openmap.metric.sampled`) | every service; outbox subscribers; integrations |
| GraphQL | `packages/contracts/graphql/schema.graphql` | 0.10.0 (ADR-010 `auditLog`; ADR-011 tenant settings; ADR-012 integrations, analytics, rack placement; ADR-013 `software`, `vulnerabilitySummaries`, `vulnerability`; ADR-014 `Ci.code`, `setCiCode`; ADR-015 `discoveryScopes`, `updateDiscoveryScope`; ADR-016 `HeadlineMetric`, `Ci.headlineMetric`; ADR-017 `onboarding`, `Organization`, `Site`, `SiteLink`, `NodeRegistration`, `CredentialSet`, the setup mutations; ADR-020 `Dashboard`, `EstateStats`, `dashboards`, `estateStats`, the dashboard mutations) | apps/api (Mercurius), apps/console, Terraform provider |
| Asset | `packages/contracts/src/asset.ts` → `asset-record`, `infra-plan`, `support-contract`, `vendor-contact` | 0.1.0 | api, console, warranty integrations |
| Impact | `packages/contracts/src/impact.ts` → `impact-scenario`, `impact-simulation` | 1.0.0 (ADR-019 `SCENARIO_KINDS` are the conditions; `SCENARIO_KIND_SEVERITY`) | bsm-engine, api, console, assistant |
| Dashboard | `packages/contracts/src/dashboard.ts` → `dashboard`, `dashboard-input` | 0.1.0 (ADR-020 personas, widget kinds and sizes, templates) | api, console |
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
| 2026-11-01 | graphql | 0.7.0: `DiscoveryScope`, `DiscoveryScopeInput`; query `discoveryScopes`; mutation `updateDiscoveryScope` | ADR-015 |
| 2026-11-01 | ci, collector, event, graphql | ci 0.2.0: `metricSampleSchema`, `HEALTH_STATES`, headline metric sources; collector 0.2.0: optional `samples`; event 0.2.0: `openmap.metric.sampled`; graphql 0.8.0: `HeadlineMetric`, `Ci.headlineMetric` | ADR-016 |
| 2026-11-04 | graphql, collector (TypeScript only) | graphql 0.9.0: `OnboardingState`, `Organization`, `BusinessUnit`, `Site`, `SiteLink`, `NodeRegistration`, `CredentialSet`, enums `OnboardingStep`, `SiteKind`; query `onboarding`; mutations `updateOrganization`, `upsertSite`, `removeSite`, `upsertSiteLink`, `removeSiteLink`, `registerNode`, `saveCredentialSet`, `addDiscoveryScope`, `setOnboardingStep`, `generateTwin`. collector: `CREDENTIAL_FIELDS` (field names per credential type; no wire change) | ADR-017 |
| 2026-11-04 | dashboard, graphql | dashboard 0.1.0 (new): `DASHBOARD_PERSONAS`, `WIDGET_KINDS`, `WIDGET_SIZES`, `DASHBOARD_TEMPLATES`, `dashboardSchema`, `dashboardInputSchema`; graphql 0.10.0: `Dashboard`, `DashboardInput`, `EstateStats`; queries `dashboards`, `estateStats`; mutations `createDashboard`, `updateDashboard`, `deleteDashboard`, `setDefaultDashboard` | ADR-020 |
| 2026-11-04 | impact | 1.0.0: `SCENARIO_KINDS` replaced by the console's conditions plus `maintenance` (`failed`, `degraded`, `power_loss`, `link_down`, `certificate_expired`, `warranty_expired`, `subscription_expired`, `end_of_life`, `vulnerability_exploited`, `capacity_exhausted`, `maintenance`); `SCENARIO_KIND_SEVERITY`, `SCENARIO_SEVERITIES`; Postgres enum migrated (0012) | ADR-019 |
| 2026-10-22 | all | Frozen; Go view checked against the emitted JSON Schemas (T-093/T-094), GraphQL bump check in CI (T-092) | ADR-002 |
