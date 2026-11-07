# ADR-043 — Warranty and EoX lookups by serial number

Status: Accepted; implemented and exercised in simulated mode (REQ-CMDB-024 stays parked until recorded vendor
responses exist) · Date: 2026-11-07 · Tracker: REQ-CMDB-024

## Context

The asset register already carries a warranty per asset (`warrantySchema`, source `vendor_api`, `purchase_record` or
`manual`) and an end of life (`endOfLifeSchema`). Discovery fills the warranty only when a collector happens to see
the dates. The end of life was only ever typed in by hand. REQ-CMDB-024 asks for vendor API lookups. Syed chose option
(c) for lifecycle data (ADR-039): a bundled catalogue for software, plus vendor EoX APIs for hardware. No vendor
credentials are available yet, so the adapters follow the vendors' published API documentation and run against
`tools/simulator` (ADR-042).

## Decision

1. A new collector family, `warranty` (collector and CI contracts 0.6.0), with a Go collector `warranty`:
   - One job is one vendor account. The job's `assets` option lists the hardware to look up: serial, CI type and name.
   - Dell TechDirect asset entitlements v5: OAuth client credentials, up to 100 service tags per call.
   - Lenovo warranty v2.5: `ClientID` header, one serial per call.
   - Cisco SN2INFO coverage summary v2: OAuth, up to 75 serials per call, paged.
   - Cisco EoX v5 by serial: up to 20 per call, paged.
   - Endpoints and token URLs are job options. Their defaults live in `packages/config`
     (`WARRANTY_*_URL`, overridable for regional gateways and simulated mode). Token and API transports honour
     `caCertPem`.
2. Each answered serial becomes an observed CI of its own type, identified by `serialNumber` alone, so the
   reconciler updates the CI that discovery created. It carries only lookup attributes:
   - warranty: `warrantyProvider`, `warrantyLevel`, `warrantyStart`, `warrantyEnd`, `inWarranty`, `warrantyVerifiedAt`;
   - Cisco support contract: `supportContractNumber`, `supportLevel`, `supportEnd`;
   - EoX: `endOfSale`, `endOfSoftwareMaintenance`, `endOfSupport`, `eoxBulletin`, `eolSource`, `eolVerifiedAt`.

   Serials the vendor does not know are skipped, not errors. `purchaseDate` and `manufacturer` are never emitted, so a
   lookup cannot overwrite what a person or another collector recorded.
3. `assetFieldsFromCi` maps the dates into the register:
   - the warranty `startsAt` comes from `warrantyStart`, falling back to the purchase date;
   - the warranty `verifiedAt` comes from `warrantyVerifiedAt`;
   - `endOfLifeFromAttributes` builds the end of life.

   The reconciler inserts and refreshes `endOfLife` under the same rule as warranty: it replaces only a value that
   still comes from `vendor_api`, never a person's entry. The Lifecycle screen's hardware view and the asset data gaps
   pick the dates up with no further change.
4. `pnpm --filter @openmap/scheduler warranty:plan` plans the jobs from the CMDB:
   - covers current hardware CIs (`WARRANTY.ciTypes`) with a serial whose manufacturer maps to an adapter
     (`WARRANTY.manufacturerPrefixes`);
   - creates jobs per vendor in chunks of `WARRANTY.assetsPerJob`, only for vendors the tenant has a credential
     reference for;
   - reports vendors without credentials and unsupported manufacturers instead of guessing.
5. HPE and IBM are not implemented. Without their API documentation and access we could not show an adapter's
   request or response shape, and an invented one would prove nothing. They stay open on REQ-CMDB-024.

## Consequences

- Asset register warranty and hardware end of life refresh from the vendor on every planned run. Outbound calls go
  from the Discovery Node only to the vendors a tenant configured.
- Simulated mode (T-355) runs the collector for the estate's 769 Dell servers, 517 Lenovo servers and 135 Cisco
  devices, covering auth, batching, paging and an unknown serial. Each answer carries the expected dates and levels,
  and every identity aligns with the estate's CI.
- REQ-CMDB-024 stays parked until recorded responses from real Dell, Lenovo and Cisco accounts replace the simulator
  as evidence, and until HPE and IBM access exists.
