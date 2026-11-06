# Asset depreciation and spare-part stock (REQ-CMDB-017, REQ-CMDB-019)

Captured 2026-11-06 on the dev compose stack with the synthetic estate. Decision: ADR-033.

## What changed

1. **Contract** (`packages/contracts/src/asset.ts`, asset 0.4.0): `bookValue` values an asset on a day from its
   purchase cost, purchase date and schedule. Straight line spreads cost minus residual over the useful life;
   declining balance applies twice the straight-line rate to what is left each month; both stop at the residual;
   `none` keeps the cost. Whole months count, rounded to cents. The value is computed on read, never stored, so it
   cannot go stale. `belowReorderPoint` marks a stocked spare whose on-hand count has reached its reorder point.
2. **API** (GraphQL 1.11.0, event 0.7.0): `AssetRecord.depreciation`, `bookValue` and `stock`; the asset form's input
   takes a schedule (useful life up to 600 months, residual in the purchase currency) and stock counts (null stops
   stock control), each audited per field; `AssetFilter.belowReorderPoint` and the per-layer summary count.
   `openmap.asset.stock.low` is emitted once when a spare reaches its reorder point, not again while it stays below.
3. **Console**: the asset form has depreciation and stock groups and shows today's book value; the register has a
   book value column with the cost beneath, a low-stock tag on the asset tag, and a low-stock filter with its count.

## Tests

| Id | What | Result |
| --- | --- | --- |
| T-173 | `packages/contracts/src/asset-value.test.ts`: straight line, declining balance, floors at the residual, whole months, no cost or date, reorder point | 3 of 3 |
| T-174 | `apps/api/src/api.integration.test.ts`: a manual spare bought 12 months ago at 4,800 SAR over 48 months is worth 3,600; declining balance matches the contract; stock 2 of 2 emits one low-stock event and 1 of 2 adds none; the filter and the summary count it; a zero useful life is refused; null stock clears stock control | 1 of 1 (suite 25 of 25) |
| T-175 | Playwright `apps/console/e2e/asset-value.spec.ts` (en, ar): a spare PSU entered through the form with a straight-line schedule and stock below its reorder point; the register shows its book value and the cost beneath, the low-stock tag and filter, and the details panel shows the book value | 2 of 2 |

Also green: the console assets suite (21 of 21), `pnpm guard`, `pnpm i18n:check`, `pnpm contracts:check`, console
lint and the CMDB e2e specs (13 of 13 in en and ar).

## Screenshots

- `console/asset-value-register-en.png`, `console/asset-value-register-ar.png`: the register narrowed to the e2e
  spare: book value 3,600 SAR of 4,800 SAR, the low-stock tag (1 of 2) and the low-stock filter.
- `console/asset-value-details-en.png`, `console/asset-value-details-ar.png`: the details panel with the schedule,
  stock counts and today's book value.
