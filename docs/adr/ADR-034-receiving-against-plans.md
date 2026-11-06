# ADR-034 — Receiving against plan lines, and discovery claiming what was received

Status: Accepted and implemented (REQ-CMDB-020, 2026-11-06) · Date: 2026-11-06 · Tracker: REQ-CMDB-020

## Context

REQ-CMDB-020 asks for purchase orders with line items and receiving. ADR-005 already decided there are no purchase
orders in OpenMap: an infrastructure plan's bill of materials is the line list, procurement stays in the finance
system and is linked by reference, "receiving moves them to `in_stock`; discovery links them to CIs and moves them to
`deployed`". Neither half was built: `BomLine.received` was stored but nothing wrote it, and a received unit that was
later racked and discovered got a second, discovery-sourced register row instead of its planned one.

## Decision

1. **Receiving is a receipt against one BOM line.** `receivePlanLine` (GraphQL 1.12.0) takes the plan, the line's
   position, the day the goods arrived, an optional reference (the ERP order or delivery note number, kept as text,
   never managed here), an optional storage location and one entry per unit: its serial number and, when the
   organisation labels on arrival, its asset tag. It may receive part of a line; the units must not exceed what is
   still outstanding.
2. **What a receipt changes, in one transaction.** The line's oldest planned units become `in_stock` with the serial,
   the tag when given, the purchase date (the receipt day, unless one was entered) and the location; each change is an
   audit row; `BomLine.received` grows; a `PlanReceipt` row (migration 0022) keeps who received what, when, under
   which reference and which assets it covered. A plan must be `approved` or `building` to receive; the first receipt
   on an `approved` plan moves it to `building`. A serial already in the register refuses the receipt and names the
   asset holding it, so a unit cannot be counted twice.
3. **Units know their line.** `asset_records.bomLineId` links each planned unit to its BOM line. Migration 0022 fills
   it for existing plans from the planned tag (`<plan>-<line>-<unit>`).
4. **Discovery claims received units by serial.** When the reconciler persists a newly created CI of an owned type
   whose serial matches a received (`in_stock`) plan unit with no CI, it links that unit to the CI and moves it to
   `deployed` instead of creating a new row; the unit keeps its plan, tag, cost and schedule. The claim is one array
   statement per batch, writes an audit row per unit with the discovery run as the actor, and emits
   `openmap.asset.stage.changed`.
5. **Events.** `openmap.plan.line.received` (event 0.8.0) with the plan, line, quantity, outstanding count, reference
   and asset ids; `openmap.asset.stage.changed` per unit, and `openmap.plan.status.changed` when the plan moves to
   `building`.
6. **The console.** Each line of an approved or building plan has a Receive action for operators: the units still
   outstanding, one serial per line (with an optional tag after a comma), the receipt day, the reference and the
   location. The plan lists its receipts.

## Consequences

- A plan now carries the procurement story end to end: planned, received into stock, discovered and deployed, with
  a register row that never splits in two.
- The finance system remains the system of record for orders, invoices and payments; OpenMap holds only references.
- Contracts: GraphQL 1.12.0 (additive), event 0.8.0 (additive), asset 0.5.0 (docs: `bomLineId`, `planReceiptSchema`).
