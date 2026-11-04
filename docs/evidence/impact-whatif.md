# What-if scenarios run end to end (REQ-BSM-003, REQ-UI-013, ADR-019)

Captured 2026-11-04 on the dev compose stack with the synthetic estate after Syed reported "Something went wrong"
on every run from Business services › Impact modeling.

## Findings, in the order they surfaced

1. `saveScenario` rejected every input: the console sends the picked condition as the scenario `kind`, the contract
   accepted only the pre-console scope kinds. Fixed by making the kinds the conditions (impact contract 1.0.0,
   migration 0012).
2. With a kind accepted, every scenario read failed the contract parse: `runbook` had no column (migration 0013).
3. With reads working, every model reported nothing affected: the impact traversal never followed `contains`, so a
   component's failure never reached its application or its business services. `contains` is now traversed from
   logical containers only (`GRAPH.impactContainerTypes`).
4. The error card showed only the generic line; validation errors now carry their reason and the card prints the
   server's message.

## Proof

- `cbs-db` (application component of the core banking system) under "Failed": Mortgage Servicing and Treasury FX
  predicted degraded (redundancy honoured, 43 min of SLA budget left) with the propagation path cbs-db → cbs → service,
  the affected-services table populated, the scenario saved and re-runnable, no error card.
- Memgraph integration test: a component reaches its service through its application; a switch port does not take
  down its switch (`packages/graph/src/memgraph.integration.test.ts`, 4 passed).
- T-122 `apps/console/e2e/impact.spec.ts`: en and ar passed on the live stack; screenshots
  `console/impact-run-{en,ar}.png`.
- Unit: contracts 13, db 81, graph 9, bsm-engine 27, api 28, console 197, assistant 17; `pnpm -w guard` ok.
