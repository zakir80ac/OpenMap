# Receiving against plan lines (REQ-CMDB-020)

Captured 2026-11-06 on the dev compose stack with the synthetic estate. Decisions: ADR-005 (plans, not purchase
orders), ADR-034 (receiving and the discovery claim).

## What changed

1. **Contract** (`packages/contracts/src/asset.ts`, asset 0.5.0): a planned unit knows its BOM line
   (`AssetRecord.bomLineId`); `planReceiptSchema` describes a delivery; `canReceive` (approved or building plans),
   `outstanding` and `parseReceivedUnits` (one unit per line, serial then an optional tag after a comma or a tab;
   blank lines skipped; an empty box, a repeated serial and more units than are outstanding refused) are shared by
   the API and the console.
2. **Storage** (migration 0022): `asset_records.bomLineId`, filled for existing plans from the planned tag
   (`<plan>-<line>-<unit>`; 19 of 19 planned units on the dev stack), and `plan_receipts` with the day, reference,
   location, who received and the assets each receipt took into stock.
3. **API** (GraphQL 1.12.0, event 0.8.0): `receivePlanLine` (operators) takes the line's oldest planned units into
   stock with the serials and tags given, sets the purchase date to the receipt day when none was entered and the
   location when chosen, audits every change, counts the units as received, records the receipt, and moves an
   approved plan to building. It refuses a draft, live or cancelled plan, more units than are outstanding, a serial
   or tag repeated in the delivery, and a serial or tag already in the register. `InfraPlan.receipts`,
   `BomLine.position`/`outstanding`. Events: `openmap.plan.line.received`, `openmap.asset.stage.changed` per unit,
   `openmap.plan.status.changed` on the move to building.
4. **Reconciler**: a newly created CI of an owned type whose serial matches a received (`in_stock`) plan unit with no
   CI claims that unit: it takes the CI and its layer and moves to deployed, keeps its plan, tag, cost and schedule,
   gets audit rows with the discovery run as the actor, and emits a stage event. One statement per batch; no second
   register row. A unit still planned is not claimed.
5. **Console**: each line of an approved or building plan has a Receive action for operators (serial box, received
   on, reference, stored at the plan's site or racks); the line shows received of quantity and "All received" when
   complete; the plan card lists its receipts.

## Tests

| Id | What | Result |
| --- | --- | --- |
| T-176 | `apps/api/src/api.integration.test.ts`: a two-line plan links its units to their lines; receiving on a draft, too many units, a repeated serial and a viewer are refused; two units received with a reference, a tag and a location go to stock with serials and the purchase date; the line counts 2 of 3, the plan is building and lists the receipt; a serial already received is refused; audits, the line event and the stage and status events are written | 1 of 1 (suite 26 of 26) |
| T-177 | `apps/reconciler/src/worker/assets.integration.test.ts`: a discovered host claims the received unit with its serial (deployed, linked, layer from the CI, plan, tag and schedule kept, two audit rows, one stage event); a unit still planned is not claimed; a second sweep claims nothing | 1 of 1 (file 2 of 2) |
| T-178 | `packages/contracts/src/receiving.test.ts`: receiving statuses, outstanding counts, the units parser and its refusals, the receipt schema | 4 of 4 |
| T-179 | `apps/console/src/components/assets/AssetsView.test.tsx` (en, ar): a draft plan offers no Receive action; an approved plan's line is received with serials, a tag, a reference and the plan's site; an empty box and too many units are refused before anything is sent; the receipt is listed and the line shows all received | 2 of 2 (suite 23 of 23) |
| T-180 | Playwright `apps/console/e2e/plan-receiving.spec.ts` (en, ar): a plan created and approved in the console, one unit received with its serial, tag and reference; the line counts 1 of 2, the plan is building, the receipt lists the serial, and the register shows the unit in stock under its tag | 2 of 2 |

## Screenshots

- `console/plan-receive-form-en.png`, `console/plan-receive-form-ar.png`: the receive form on an approved plan's line.
- `console/plan-receipts-en.png`, `console/plan-receipts-ar.png`: the plan in building with the line counted and the
  receipt listed.
