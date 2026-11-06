# ADR-035 — Vendors, contracts and cost centres are CIs; one commercial register over them

Status: Accepted · Date: 2026-11-06 · Tracker: REQ-CMDB-026, REQ-CMDB-027, REQ-CMDB-028, REQ-CMDB-029

## Context

Device42 keeps vendors, contacts, support contracts, general contracts with their documents, and customers,
departments and cost centres (CAPABILITY-MAP §2). OpenMap already models the commercial side as CIs: `vendor`,
`contract` and `cost_centre` are CI types, the synthetic estate and integrations write them, and the graph links them
(`host —covered_by→ contract —supported_by→ vendor`, `contract —billed_to→ cost_centre`). ADR-023 had also added a
`support_contracts` table that an asset pointed at through `supportContractId`; nothing writes that table, so on the
dev estate 2,000 hosts covered by a contract in the graph were still flagged as missing support cover. Vendor
contacts are people, not configuration items, and live in `vendor_contacts` keyed by the vendor CI.

## Decision

1. **The CI is the record.** A contract is a `contract` CI (identity: vendor name and contract number) whose
   attributes carry the kind (`CONTRACT_KINDS`: support, maintenance, warranty extension, licence, SaaS, lease,
   service, other), title, support level and response time, start and end, auto-renewal, notice period, annual cost
   and currency, and its documents (title and location: the organisation's document system or a file share; OpenMap
   stores the reference, not the file). A vendor is a `vendor` CI (category, support portal, account manager). A cost
   centre is a `cost_centre` CI with a kind (`COST_CENTRE_KINDS`: cost centre, department, customer), code, owner,
   budget and currency. Commercial CIs created or edited by a person go through the CI service and the outbox, so the
   graph, search and history carry them like discovered ones.
2. **Links are relationships.** Contract to vendor is `supported_by`, contract to cost centre `billed_to`, a covered
   CI to its contract `covered_by`. Editing a contract replaces its vendor and cost-centre links.
3. **An asset's support contract is the contract CI that covers it.** `asset_records.supportContractId` now references
   the contract CI (migration 0023 drops `support_contracts`, re-points the foreign key at `cis` and fills the column
   from each asset's current `covered_by` relationship, latest end date first). The reconciler keeps it current when a
   sweep or an import creates or retires a `covered_by` relationship; `setAssetContract` sets it from the console
   together with the relationship. The register's support gap, expiry counts and `AssetRecord.supportContract` read
   it, so a covered asset is no longer a gap. `AssetRecord.ownerCostCentre` (column `ownerCostCentreCiId`) is set
   through the asset details input.
4. **One commercial register.** GraphQL 1.13.0: `contracts(filter)` (kind, vendor, cost centre, text, expiring
   within days, expired) with covered-asset counts, days to end and the notice date; `vendors(text)` with contract,
   coverage, cost and contact counts; `vendor(id)` with its contacts in escalation order and contracts;
   `costCentres` with budget, contract cost and asset and plan counts; mutations `upsertContract`,
   `upsertVendor`, `upsertVendorContact`, `deleteVendorContact`, `upsertCostCentre`, `setAssetContract`.
   Operators write; every role reads.
5. **The console** gets a Commercial screen with Contracts, Vendors and Cost centres tabs; the asset details panel
   chooses the covering contract and the owning cost centre.

## Consequences

- One place for commercial truth, shared by discovery, imports (ADR-032) and people; no table that drifts from the
  graph.
- `support_contracts` is gone; `SupportContract` in GraphQL now describes the contract CI (same fields).
- Contract expiry feeds the register's support counts at once; a scheduled expiry notification is a separate
  requirement.
