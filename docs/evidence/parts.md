# Device parts and components (REQ-CMDB-014)

Captured 2026-11-07 on the dev compose stack. Decision: ADR-037.

## What changed

1. **Contract** (CI 0.3.0, collector 0.3.0, `packages/contracts/src/component.ts`): `ObservedCi.components`, the part
   list a collector reports (kind, slot, model, manufacturer, serial, part number, capacity, firmware, details);
   `normalizeComponents`, `diffComponents`, `componentTotals`; event 0.10.0 `openmap.component.changed`.
2. **Storage** (migration 0025): `ci_components`, one row per parent, kind and slot; removed parts keep their row.
3. **Reconciler** (`apps/reconciler/src/worker/components.ts`): mirrors observed lists in array statements, closes
   parts no longer reported, closes a serial on its old parent when another reports it (moved), restarts
   `firstSeenAt` on a new serial (replaced), raises `openmap.component.changed` for a CI whose stored parts changed;
   counter `openmap_reconciler_components_total{action}` inside the `reconcile.result` span.
4. **Collectors** (Go): SSH Linux (CPU sockets, `lsblk -P` disks with serials, physical NICs, FC HBAs, DIMMs from
   dmidecode when readable), WMI (processors, DIMMs, physical drives, hardware adapters, FC initiator ports), Redfish
   (Processors, Memory, Storage drives, NetworkAdapters, PowerSupplies). The synthetic estate gives every server its
   parts on a stream of its own (no other generated value moves); the dev estate holds 44,978 parts over 2,000 hosts.
5. **API** (GraphQL 1.15.0): `Ci.components(includeRemoved)`, `components(filter, first, offset)` with the most common
   kind-and-model rows.
6. **Console**: a Parts tab on every CI and a Parts register under Discover.

## Tests

| Id | What | Result |
| --- | --- | --- |
| T-192 | `packages/contracts/src/component.test.ts`: part validation, one per kind and slot, observed CIs with and without parts, diff (added, removed, replaced), totals, event data | 3 of 3 (suite 36 of 36) |
| T-193 | `apps/reconciler/src/worker/components.integration.test.ts` against Postgres: a first list stores parts without an event (last list wins in a batch), a later sweep replaces, removes and adds with one event, a serial moving to another host closes it on the first, an unchanged sweep does nothing | 1 of 1 (integration 7 of 7) |
| T-194 | `apps/collectors/internal/sshlinux/components_test.go`: sockets, DIMMs, whole disks only, NIC speeds, HBA WWPN, the host observation's parts, the commands in the script | 2 of 2 |
| T-195 | `apps/collectors/internal/windows/components_test.go`: sockets, DIMMs, drives, hardware NICs only, FC initiator ports | 1 of 1 |
| T-196 | `apps/collectors/internal/redfish/components_test.go`: processors, DIMMs (absent skipped), storage drives, chassis adapters and power supplies over a Redfish walk | 1 of 1 |
| T-197 | `apps/api/src/api.integration.test.ts`: a CI's parts (current, and with removed), the register by kind, text and removed, the common models, paging and the page-size limit | 1 of 1 |
| T-198 | `apps/console/src/components/parts/PartsView.test.tsx` (en, ar): register rows with localised details, common models, filters and paging reaching the query; a CI's Parts tab in kind order with removed parts on request | 5 of 5 (console 307 of 307) |
| T-199 | Playwright `apps/console/e2e/parts.spec.ts` (en, ar): the register on the dev estate, the HBA filter, a hypervisor's Parts tab with processors, memory, drives, adapters, HBAs and power supplies | 2 of 2 |

Go: `go test ./...` in `apps/collectors` and `apps/node` pass (the contract test checks the Go types against the
emitted JSON Schema, now 0.3.0).

## Screenshots

- `console/parts-en.png`, `console/parts-ar.png`: the Parts register with the most common models.
- `console/parts-ci-en.png`, `console/parts-ci-ar.png`: a hypervisor's Parts tab.
