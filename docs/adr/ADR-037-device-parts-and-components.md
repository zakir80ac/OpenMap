# ADR-037 — Device parts and components

Status: Accepted and implemented (REQ-CMDB-014, 2026-11-06) · Date: 2026-11-06 · Tracker: REQ-CMDB-014

## Context

Device42 records the parts inside a device (processors, DIMMs, drives, NICs, HBAs, power supplies) with model,
serial and slot, so an engineer can see what a server holds, trace a replaced or moved disk, and count spares by model
(CAPABILITY-MAP §2). OpenMap's collectors read most of this already (`/proc/cpuinfo`, `lsblk`, Redfish, WMI) but kept
only totals on the host (`cpuCount`, `memoryGb`, `disks` as text). The CI contract allows scalar attribute values only,
and a 40k-host estate with about twenty parts each would add some 800k graph nodes if parts were CIs, none of which a
dependency ever points at.

## Decision

1. **Parts ride on the observation, not in attributes.** `ObservedCi.components` (collector contract 0.3.0, CI
   contract 0.3.0, `packages/contracts/src/component.ts`) is an optional list of parts: kind (`cpu`, `memory`, `disk`,
   `nic`, `hba`, `gpu`, `psu`, `controller`), slot (unique per kind within the parent), model, manufacturer, serial,
   part number, capacity in bytes, firmware and kind-specific details. Absent means the collector does not see parts
   and the stored parts are left alone; present (even empty) is the full set.
2. **Parts are rows, not CIs.** The reconciler mirrors each list into `ci_components` (migration 0025): one row per
   parent, kind and slot, upserted per batch with array statements. A part no longer reported keeps its row with
   `removedAt`; the same serial reported by another parent closes the old row (the part moved); a new serial in a slot
   restarts `firstSeenAt` (the part was replaced). The CI's attributes, the graph, search and history stay as they were.
3. **Changes are events.** When a CI that already had parts reports added, removed or replaced ones, the reconciler
   raises `openmap.component.changed` (event 0.10.0) through the outbox; a first part list is not a change.
   Prometheus counter `openmap_reconciler_components_total{action}`; the work runs inside the `reconcile.result` span.
4. **Collectors.** SSH (Linux): CPU sockets from `/proc/cpuinfo`, whole disks from `lsblk -P` (bytes, model, serial,
   transport, media), physical NICs from `/sys/class/net`, FC HBAs from `/sys/class/fc_host`, DIMMs from `dmidecode`
   when readable. WMI: `Win32_Processor`, `Win32_PhysicalMemory`, `Win32_DiskDrive`, hardware `Get-NetAdapter`,
   `Get-InitiatorPort`. Redfish: Processors, Memory, Storage drives, chassis NetworkAdapters and PowerSupplies.
5. **Reading them.** GraphQL 1.15.0: `Ci.components(includeRemoved)` and `components(filter, first, offset)` (kind,
   text over model, manufacturer, serial, part number, slot and parent name; removed on request) with the most common
   kind-and-model rows. The console has a Parts tab on every CI and a Parts register under Discover.

## Consequences

- Replacements and moves are traceable by serial without graph growth; spares can be planned from model counts.
- A collector that cannot see parts (cloud, SNMP-only devices) simply omits the list.
- Parts are not individually linked to contracts or warranties; the parent CI's asset record carries those.
