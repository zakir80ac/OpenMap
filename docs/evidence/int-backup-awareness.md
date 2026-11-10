# Backup and DR awareness: Veeam, Commvault, Rubrik (REQ-INT-017, ADR-075)

Captured 2026-11-10. **The tracker row stays Blocked.** No Veeam Backup & Replication, Commvault or Rubrik system is
available, and Syed's decision of 2026-11-07 parks vendor rows until real access exists. Everything vendor-facing below
was exercised against unit-test servers built from the vendors' published REST API references and against simulated
mode (ADR-042, provenance `simulated`). No response here is a recorded capture, and none closes the row (risk R-004).
The row closes when a run against a real server of each product is recorded as a fixture.

## What was built

| Layer | Where | What |
| --- | --- | --- |
| Contracts | `packages/contracts/src/protection.ts`, `ci.ts`, `collector.ts`; GraphQL 1.47.0; CI and collector 0.14.0 | `backup_policy` CI type; `backup` family; policy and cover attributes, job options and inventory; `judgeProtection` |
| Database | migration `0052_backup_awareness`, Memgraph `0005_backup_policy.cypher` | `CiType` and `CollectorFamily` enum values; `:BackupPolicy` label index (both applied to the compose stack) |
| Collector | `apps/collectors/internal/backup`, `cmd/backup` | Veeam REST v1, Commvault Command Center REST, Rubrik CDM adapters; inventory matching; `backed_by` covers |
| Planner | `apps/scheduler/src/core/backup.ts`, `backup-plan.ts` (`pnpm --filter @openmap/scheduler backup:plan`) | one job per backup server, with the CMDB's VMs and hosts as the inventory |
| Simulated mode | `tools/simulator/internal/vendors/{veeam,commvault,rubrik,backupsim}`; `tools/synth-estate/src/gen/backup.ts` | the three APIs rendered from the estate's new backup stream |
| API | `apps/api/src/protection` | `ciProtection`, `protectionGaps`; spans `bsm.protection.ci` and `bsm.protection.gaps`; counter `openmap_protection_reads_total{query}` |
| Console | `components/protection/ProtectionCard.tsx` (on the CI detail), `ProtectionView.tsx` (`/protection`, nav under Services) | 63 i18n keys in both en and ar; bidi-isolated names in Arabic |

## Tests

| Test | Type | What | Result |
| --- | --- | --- | --- |
| T-650 | unit (contracts) | judgement (no cover, newest backup, strictest RPO, breach, never backed up), inventory keys, database agents, the CI type and manifest | 6 of 6 pass (contracts suite 116 of 116) |
| T-651 | unit (Go) | Veeam: password grant with `x-api-version`, paging, schedules → RPO, retention in days or points, VM with no backup; matching by moRef, name and FQDN, ambiguous keys; rejected password; `verifyTls` against an untrusted server; unknown vendor | 6 of 6 pass |
| T-652 | unit (Go) | Commvault: Base64 login, an errList on a wrong password, plan and storage policy, agents and subclients, last completed job. Rubrik: service-account session, SLA frequencies → RPO and retention, VM paging, filesets per host. Result normalisation | 5 of 5 pass |
| T-653 | simulated (Go) | the real `backup` collector against each simulator, TLS verified against the per-process CA | 3 of 3 pass |
| T-654 | unit (synth-estate) | the backup stream: policies and slots per vendor, every cover to a `backup_policy`, unprotected and stale CIs present, deterministic | 4 of 4 pass (suite 45 of 45, T-450 and T-454 still green) |
| T-655 | integration (API against compose Postgres and Memgraph) | protected, past the RPO, uncovered, inherited cover via a SQL Server agent, File System only not inherited; gaps for tiers 2 and 3, truncation; GraphQL through the resolvers; invalid `maxTier` refused; metric counted | 4 of 4 pass |
| T-656 | integration (reconciler against compose Postgres) | a backup collector result through `processResult`: the policies stored, covers resolved to the CIs discovery stored (by inventory identity and by FQDN), the unknown object parked as pending, re-observation idempotent | 1 of 1 pass |
| T-657 | component (console) | ProtectionCard and ProtectionView in en and ar: states, inherited cover, services, empty, truncated, tier change | 14 of 14 pass (console suite 398 of 398) |
| T-658 | unit (scheduler) | inventory of VMs and hosts with keys, one contract-valid job per server with the vendor's credential type, vendor pairs | 3 of 3 pass |
| T-659 | e2e (Playwright, en and ar) | `apps/console/e2e/protection.spec.ts`: totals, the table or the empty state, tier change, the Protection card on a CI | written, not run: the shared console and API images were not rebuilt in this session |

## Simulated mode

`pnpm --filter @openmap/simulator verify` passes **500 of 500 runs** across 42 simulators, with identity drift 0,
relationship drift 0 and no attribute mismatches. Totals: 66,585 of 66,585 CIs and 84,606 of 84,606 relationships.
The estate was regenerated at seed 42, scale 0.05.

| Simulator | Collector | Policies | Covers (`backed_by`) | Drift |
| --- | --- | ---: | ---: | ---: |
| veeam-backup-replication | backup | 4 / 4 | 491 / 491 | 0 |
| commvault-command-center | backup | 4 / 4 | 1,319 / 1,319 | 0 |
| rubrik-cdm | backup | 3 / 3 | 410 / 410 | 0 |

Each simulator checks credentials the way the product does:
- Veeam: password grant, bearer token, `x-api-version`.
- Commvault: Base64 password login, `Authtoken`.
- Rubrik: service-account session, bearer token.

Each one pages the way the product does. Its run carries the inventory a planner would build from the CMDB. The
estate's VMs carry no `vcenter`/`moRef` attributes, so simulated runs match VMs by name (Veeam) and by name or address
(Rubrik). The moRef key is used once the real vmware collector has stored those attributes.

## The chain, link by link

The chain is simulator → collector → result → reconciler → Postgres and Memgraph → API → console:
- simulator → collector: T-653 and verify;
- collector-shaped result → reconciler → Postgres: T-656;
- Postgres and Memgraph → API: T-655;
- API → console: T-657, and T-659 once the images are rebuilt.

A full compose run (simulated profile, Node, scheduler, `backup:plan`) was not made in this session. The session rules
forbid rebuilding or restarting the shared containers, and the running images predate the new family. The air-gap
profile adds nothing for this requirement. The collector talks only to its target, and the API and console make no
outbound call. It has not been run in the air-gap profile yet.

## Known limits

- Not built yet, for lack of documented shapes to build against:
  - Veeam agent jobs (physical machines);
  - Commvault virtual-server (VSA) subclients;
  - Rubrik databases as objects of their own.
- A replayed estate's covers read as past their RPO, because the estate's times are relative to its epoch.
- Not yet captured: RTL screenshots and the Lighthouse budget for `/protection`. Both need the rebuilt console image.
