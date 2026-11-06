# Vendors and contracts: support contracts, vendors and contacts, cost centres, contracts and documents (REQ-CMDB-026, REQ-CMDB-027, REQ-CMDB-028, REQ-CMDB-029)

Captured 2026-11-06 on the dev compose stack with the synthetic estate. Decision: ADR-035.

## What changed

1. **Contract** (`packages/contracts/src/commercial.ts`, asset contract 0.6.0): contract kinds (support, maintenance,
   warranty extension, licence, SaaS, lease, service, other) and cost-centre kinds (cost centre, department,
   customer); a contract's documents by reference (title and location); the attribute names of a contract CI; the
   inputs a person enters for a contract, a vendor and a cost centre (dates in order, a cost or budget with its
   currency); days to end and the notice date.
2. **Storage** (migration 0023): the `support_contracts` table nothing wrote is dropped. `asset_records.
   supportContractId` now names the contract CI that covers the asset and was filled from each asset's current
   `covered_by` relationship (2,269 of 11,515 assets on the dev estate, which until then counted as missing support
   cover); `ownerCostCentreCiId` references a cost-centre CI. `refreshCoveringContracts` (packages/db) keeps the link
   current: an asset keeps the contract a person chose while it still covers it, otherwise takes the covering contract
   that ends last, or none. The reconciler calls it for every `covered_by` a sweep or an import creates, the API for
   every one a person creates or retires.
3. **API** (GraphQL 1.13.0): `contracts(filter)` with kind, vendor, cost centre, text, ending-within and ended
   filters, days to end, notice date, annual cost, covered assets and documents; `vendors` with active and total
   contracts, covered assets, annual cost and contacts; `vendor(id)` with its contacts in escalation order and its
   contracts; `costCentres` with budget, contract cost, and the assets and plans they own. Operators write:
   `upsertContract` (a contract CI through the outbox, its `supported_by` vendor and `billed_to` cost centre kept to
   one link each; the vendor and contract number identify it and cannot change), `upsertVendor`, `upsertCostCentre`,
   `upsertVendorContact`, `deleteVendorContact`, `setAssetContract` (links the asset's CI `covered_by` the contract
   and audits the choice), and `AssetDetailsInput.ownerCostCentreId`. `AssetRecord.supportContract` reads the
   contract CI, its vendor and the vendor's first contact.
4. **Console**: a Vendors and contracts screen (navigation under Discover) with Contracts, Vendors and Cost centres
   tabs, headline counts (active, ending within 30 days, ended, vendors, cost centres), forms to add and edit each
   record, a vendor's escalation path with contacts added, edited and removed; the asset details panel shows and
   chooses the covering contract and the owning cost centre.

## Tests

| Id | What | Result |
| --- | --- | --- |
| T-181 | `packages/contracts/src/commercial.test.ts`: kinds from attributes, days to end and notice date, lenient document reads, contract, vendor and cost-centre inputs | 3 of 3 |
| T-182 | `apps/api/src/api.integration.test.ts`: vendor (viewer and duplicate refused), contacts in escalation order (bad email refused), department with budget, support contract with document, days left and notice date; identity change and reversed dates refused; cost centre unlinked and relinked; an asset covered through `setAssetContract` (support gap closes, vendor and first contact read), owned by the department (a non-cost-centre refused), a second asset covered through a plain `covered_by`; the register, vendor and cost-centre counts; unlinking reopens the gap; audits | 1 of 1 (suite 27 of 27) |
| T-183 | `apps/reconciler/src/worker/assets.integration.test.ts`: the asset's contract follows its CI's `covered_by` links (latest end first, a chosen one kept while it covers, the next one after a link is retired, none at the end) | 1 of 1 (file 3 of 3) |
| T-184 | `apps/console/src/components/commercial/CommercialView.test.tsx` (en, ar): helpers; the register with days left, ended contracts and document links (a share path stays text); kind and horizon filters; a new contract saved with documents and currency normalised; a vendor's escalation path, a contact added and removed; a department added; analysts read only | 6 of 6 |
| T-185 | Playwright `apps/console/e2e/commercial.spec.ts` (en, ar): vendor and contact, department, support contract with a signed document, the register row with its link and cost; an asset covered by the contract from its details panel, the register counting it | 2 of 2 |

## Screenshots

- `console/commercial-contracts-en.png`, `console/commercial-contracts-ar.png`: the contract register with the new
  contract, its days left, cost and document link.
- `console/commercial-asset-en.png`, `console/commercial-asset-ar.png`: an asset's details panel covered by the
  contract, with the vendor and its first-line contact.
