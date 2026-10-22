# ADR-005 — Infrastructure plans with a BOM replace purchase orders

Status: Accepted · Date: 2026-10-22 · Tracker: CMDB asset rows

## Context

Device42 models purchase orders. Syed said: no purchase orders; instead "plan for new infra or stack and enter the details (BOM etc.)". Procurement happens in the finance system.

## Decision

`infraPlanSchema`: name, kind (new infrastructure, stack expansion, refresh, migration, decommission), status (draft, approved, building, live, cancelled), owner, target site and racks, cost centre, BOM lines (each tagged with a layer), cost estimate, external procurement references, planned live date. Each BOM line creates `quantity` asset records in stage `planned`; receiving moves them to `in_stock`; discovery links them to CIs and moves them to `deployed`. Asset stage `ordered` is removed.

## Consequences

Finance systems (SAP, Coupa, Oracle ERP) are reference-only integrations. The Assets screen leads with "Plan new infra or stack".
