# ADR-033 — Asset depreciation and spare-part stock control

Status: Accepted and implemented (REQ-CMDB-017, REQ-CMDB-019, 2026-11-05) · Date: 2026-11-05 · Tracker: REQ-CMDB-017, REQ-CMDB-019

## Context

Device42 values assets by depreciation and tracks spare parts with reorder points (CAPABILITY-MAP §4, "asset
financials" and "spare parts"). The register of ADR-023 already stored a depreciation method, useful life and
residual value on every row and nullable stock counts, but every writer set the method to `none` and nothing read
the counts.

## Decision

1. **The book value is computed, not stored.** `bookValue` in the asset contract values an asset on a date from its
   purchase cost and date and its schedule: straight line spreads cost minus residual evenly over the useful life;
   declining balance applies twice the straight-line rate to what is left each month; both stop at the residual;
   `none` keeps the cost. Whole months count (`monthsBetween`), rounded to cents. A stored value would go stale
   every month.
2. **GraphQL 1.11.0, additive.** `AssetRecord.depreciation`, `bookValue` (today, null without a cost and a purchase
   date) and `stock`; `AssetDetailsInput.depreciation` (`method`, `usefulLifeMonths` up to
   `ASSETS.maxUsefulLifeMonths`, `residualValueAmount` in the purchase currency) and `stock` (`onHand`,
   `reorderPoint`; null stops stock control); `AssetFilter.belowReorderPoint`; `AssetSummary.belowReorderPoint`.
   Both inputs are audited per field like every other detail.
3. **Low stock is an event at the crossing.** A spare whose on-hand count reaches its reorder point (on creation or
   an update) emits `openmap.asset.stock.low` (event 0.7.0) with the counts. Staying below the point does not emit
   again, so a notification rule fires once per shortage.
4. **The console.** The asset form has depreciation and stock groups (stock needs both counts or neither) and shows
   today's book value; the register has a book value column with the cost beneath and marks low-stock spares; a
   "low stock" filter with its count narrows the register to them.

## Consequences

- Finance sees today's value without a nightly job; a report as of another date calls the same contract function.
- Stock counts are entered by people (or by the receiving of a plan's BOM, REQ-CMDB-020); a consumption feed from a
  ticketing tool is an integration, not part of this decision.
