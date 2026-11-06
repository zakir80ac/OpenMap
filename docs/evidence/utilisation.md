# Resource utilisation (REQ-CMDB-034)

Captured 2026-11-07 on the dev compose stack. Decision: ADR-038.

## What changed

1. **Contract** (CI 0.4.0, collector 0.4.0, `packages/contracts/src/utilisation.ts`): the CPU, memory, disk and power
   metric per CI type (`host.*`, `vm.*`, `container.*`, `dcim.power.watts`), `measureOfMetric`, `utilisationState`
   (hot at `UTILISATION.hotPercent` 85, idle at `idlePercent` 10).
2. **Collectors** (Go): `Observation.Samples` carried into the result. SSH Linux samples CPU (two `/proc/stat` reads),
   memory (MemAvailable) and the fullest filesystem; WMI samples `_Total` processor time, memory and the fullest
   volume; Redfish samples power drawn.
3. **Dev data**: synth-estate `utilisation-history` (14 days, every 6 hours) replayed through the real reconciler:
   912 results, 712,500 samples, none dropped (`.local/replay-util.log`).
4. **API** (GraphQL 1.16.0): `utilisation(filter, sort, first, offset)` over `metrics_latest` with hot and idle counts,
   averages and total power; `Ci.utilisation(hours)` bucketed from `metrics` with average and peak.
5. **Console**: a Utilisation screen under Insight; a Utilisation tab on hosts, VMs, containers and PDUs.

## Tests

| Id | What | Result |
| --- | --- | --- |
| T-202 | `packages/contracts/src/utilisation.test.ts`: metric names follow the convention and map back; hot, idle, normal, unknown | 2 of 2 (suite 38 of 38) |
| T-203 | Go: `sshlinux/utilisation_test.go` (CPU between two reads, MemAvailable, fullest mount, host and VM names, nothing when unreadable, the commands in the script), `windows/utilisation_test.go` (processor time, memory, fullest volume), `redfish/redfish_test.go` (power sample) | pass |
| T-204 | `tools/synth-estate/src/synth.test.ts`: the history is deterministic, schema-valid, sample-only, has every instant, hot and idle CIs, power and VM memory | 1 of 1 (suite 22 of 22) |
| T-205 | `apps/api/src/api.integration.test.ts` against ClickHouse: register hottest first, sort by power, idle and VM filters, totals and averages; a CI's 24-hour series leaves out older samples, latest, average and peak; default window 168 hours; an over-long window refused | 1 of 1 |
| T-206 | `apps/console/src/components/utilisation/UtilisationView.test.tsx` (en, ar): register order, state tags, power, total kW, filters and sort reaching the query; a CI's tab with latest, average and peak and the window reaching the query; the colour rule | 5 of 5 |
| T-207 | Playwright `apps/console/e2e/utilisation.spec.ts` (en, ar): the dev register leads with a hot CI, the idle filter keeps idle CIs only, a server's Utilisation tab charts CPU, memory, disk and power | 2 of 2 |

## Screenshots

- `console/utilisation-en.png`, `console/utilisation-ar.png`: the register.
- `console/utilisation-ci-en.png`, `console/utilisation-ci-ar.png`: a hot server's Utilisation tab.
