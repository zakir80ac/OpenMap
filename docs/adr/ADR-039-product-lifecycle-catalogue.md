# ADR-039 — Product lifecycle catalogue (OS inventory and end of sale / support)

Status: Accepted and implemented (REQ-CMDB-023, REQ-CMDB-025, 2026-11-07) · Date: 2026-11-07 · Tracker: REQ-CMDB-023,
REQ-CMDB-025 (vendor EoX and warranty APIs: REQ-CMDB-024)

## Context

Device42 tracks operating systems with their end of life and hardware end of sale and support (CAPABILITY-MAP §2).
OpenMap's collectors report OS and platform versions, but no lifecycle dates existed, and dates must never be typed
from memory (risk R-004). Syed chose option (c) on 2026-11-06: a bundled snapshot of endoflife.date (MIT-licensed data)
refreshed by an optional tenant-enabled sync, plus vendor EoX APIs.

## Decision

1. **A shared catalogue** (`lifecycle_entries`, migration 0026, not per tenant): one row per source, product and release
   cycle with release date, end of active support, end of security support (end of life), extended support, latest
   version and LTS. The contract (`lifecycle.ts`, CI 0.5.0) normalises endoflife.date rows (dates or booleans) and is the
   only place release rules live.
2. **Bundled snapshot.** `packages/db/lifecycle/endoflife-date.json` holds the publisher's rows exactly as fetched for
   the `LIFECYCLE.products` list (34 products: OS, hypervisors, network OS, databases, platforms).
   `node packages/db/dist/cli.js lifecycle-snapshot` refreshes it from `LIFECYCLE_CATALOGUE_URL`; the compose `migrate`
   job (`all`) loads it, so an air-gapped install has the catalogue with no outbound call.
3. **Optional sync.** `syncLifecycleCatalogue` (admin) refreshes the catalogue at runtime only when the deployment and
   tenant allow outbound calls (the integrations gate: not airgap, `FEATURE_OUTBOUND_INTEGRATIONS`, tenant
   `outboundIntegrationsEnabled`); it is audited (`lifecycle.synced`) and reports products it could not fetch.
4. **Matching.** `osRelease` maps what SSH (`id`, `versionId`), WMI (`caption`) and other sources report to a product and
   cycle (Ubuntu 24.04, RHEL 9, Windows Server 2012 R2…); `platformRelease` maps network OS (`osName`, `osVersion`: IOS
   XE, PAN-OS, FortiOS, TMOS) and hypervisor products (vSphere, Nutanix AOS, Hyper-V). What the catalogue does not cover
   (Nutanix AHV, NX-OS, Arista EOS) is shown as such, never guessed.
5. **States.** `lifecycleState`: ended, ending within `LIFECYCLE.endingDays` (180), supported, or unknown without a date.
   Operating systems also show hosts last patched longer ago than `LIFECYCLE.patchStaleDays` (90).
6. **Hardware EoX** comes from the asset register's `endOfLife` (entered, imported, or set by a vendor lookup), grouped
   by model with the earliest date governing. Vendor EoX and warranty APIs (Cisco EoX, Dell, HPE, Lenovo, IBM) are
   REQ-CMDB-024 and need tenant credentials.
7. **Reading it.** GraphQL 1.17.0: `lifecycleReleases`, `lifecycleHardware`, `lifecycleCatalogue`,
   `syncLifecycleCatalogue`; the console's Lifecycle screen (operating systems, hypervisors and network OS, hardware,
   catalogue).

## Consequences

- End of life is visible for every OS and platform the catalogue covers from discovery alone, offline.
- Snapshot freshness is the release's date unless a tenant enables the sync.
- Products the catalogue lacks need vendor sources (REQ-CMDB-024) or manual entry on the asset.
