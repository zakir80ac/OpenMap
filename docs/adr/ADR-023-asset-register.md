# ADR-023 — The asset register follows the CMDB: every owned CI, unknown devices, cover dates entered by hand

Status: Accepted · Date: 2026-11-05 · Tracker: REQ-CMDB-039, REQ-CMDB-040 · Contracts: asset 0.2.0, event 0.3.0, GraphQL 1.0.0

## Context

Asset management (REQ-CMDB-002, ADR-005) only knew the planned units a plan's bill of materials produced. Syed's
review: "asset management is also dummy, just showing planned"; the register must show everything the organisation
owns across every layer (DCIM, personal computers, network and security, servers, storage, virtualization, operating
systems, applications, databases, licences, cloud and SaaS subscriptions), plus the devices discovery found but could
not classify, with remediation or manual entry where a device has no out-of-band management (an unmetered PDU, an
unknown application on a non-standard port). Every asset must carry warranty, support and end-of-life dates.

The CMDB already holds the items: 9,481 current CIs of the dev estate are of a type the organisation owns, and their
attributes already carry what the collectors observed (asset tags, serial numbers, make and model, vendor warranty
end dates, purchase dates, licence expiries). Nothing turned those into register rows.

## Decision

- **Owned types.** `OWNED_CI_TYPES` in the asset contract names the CI types that are property, licences or
  subscriptions (hosts, chassis, blades, BMCs, hypervisors, clusters, VMs, operating systems, Kubernetes clusters,
  network devices, load balancers, storage arrays, FC switches, databases, certificates, applications, software,
  software instances, licences, racks, PDUs, UPSs, cooling units, patch panels, cloud accounts and resources, SaaS
  applications and tenants). Addresses, interfaces, records, rules, workloads, sites, accounts and vendors are
  topology or context, not assets.
- **One asset per owned CI, kept by the reconciler.** `persist()` creates a register row (`source: discovery`,
  stage `deployed`) for every created CI of an owned type in the same transaction as the CI, and refreshes the
  discovery-observed fields of existing rows on every update: a value the collector reports replaces the stored
  one, one it does not report leaves the row alone, and warranty or support cover is replaced only while it still
  comes from a vendor API, never over a person's entry. One array statement per batch keeps the sweep budget. The
  tag prefers the organisation's own (`attributes.assetTag`), then the CI code, then the CI id; a unique index on
  (tenant, ciId) makes the row idempotent. The mapping from attributes (`assetFieldsFromCi`) lives in the contract
  package so the reconciler, the API and migration 0015's one-off backfill of existing estates agree. Dates are taken
  as observed; nothing is invented, so a missing date is a data gap.
- **Data gaps are first-class.** `assetDataGaps()` lists which of warranty, support and end of life a row lacks;
  the register filters on them and `assetSummary` counts them per layer beside cover already expired. Support can be
  a `SupportContract` row (ADR-005) or a `support` entry on the asset itself; the row's `supportEndsAt` resolves
  either.
- **Manual entry, audited.** `updateAsset` records identity, purchase, custodian, warranty, support and end of life;
  each changed field is an `asset_audits` row and the event `openmap.asset.updated` lists the fields. Cover a person
  enters is stamped `manual` and verified now. `createAsset` records equipment discovery cannot see: it creates a CI
  of the chosen type through the outbox (so the graph and search carry it) and the register row with it
  (`source: manual`), so the CMDB stays the single record.
- **Unknown devices get a diagnosis.** The Assets screen lists the unknown layer with a rule-based diagnosis from
  what the scanners recorded (`diagnoseUnknown`): power equipment answering SNMP goes to the DCIM collector scope; a
  device answering SNMP needs a credential; an open port outside the well-known set is an unknown application
  needing an agent/SSH credential or a label; no SNMP, no web interface and no open port is a device without
  out-of-band management, manual entry only; a device not seen for `ASSETS.unknownStaleDays` is stale. Each row
  carries its evidence and the suggested layer and type, and the label panel opens preset with them. Labelling a CI
  into an owned type creates its register row at once (`ensureAssetForCi`, called by `labelCi`), so the person then
  fills the cover dates.
- **Contracts.** `AssetRecord.manufacturer` and `model` become nullable (a software instance or a cloud resource
  has neither) — a breaking change, so GraphQL goes to 1.0.0 together with `AssetSource`, `AssetDataGap`,
  `Warranty`, `Support`, `EndOfLife`, `AssetAudit`, `AssetSummary`, `AssetFilter`, the detail and manual inputs,
  `assetSummary`, `updateAsset` and `createAsset`. The asset contract (0.2.0) gains `source`, `layer`, `ciType`,
  `support`, nullable `warranty.level`/`startsAt`, `OWNED_CI_TYPES`, `ASSET_SOURCES`, `ASSET_DATA_GAPS`,
  `assetDataGaps`, `assetFieldsFromCi`; the event contract (0.3.0) gains `openmap.asset.created` and
  `openmap.asset.updated`.
- **Retirement.** No path retires CIs automatically yet (the stale sweep is REQ-DISC-030); when one lands, an asset
  follows its CI to `retired`. A replay reset deletes discovery-sourced rows with the CIs they describe and keeps
  plan and manual rows.

## Consequences

- The register of the dev estate holds 9,481 discovered rows plus the 17 planned ones: 2,000 hosts with their vendor
  warranty, 252 network devices, 26 licences with their expiry as subscription cover, and 7,200 rows with at least one
  gap that the "Missing any date" filter surfaces for entry.
- The reconciler's persist does two more array statements per result (plus two short retries only when a tag
  collides); the 2,000-CI result stays inside its transaction budget.
- Finance (costing, depreciation, ROI) builds on these rows; the depreciation columns keep their one-month schema
  minimum until that module assigns schedules.
