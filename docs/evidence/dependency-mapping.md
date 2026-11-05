# Application dependency mapping from flows, listeners and processes (REQ-DEP-002, ADR-029)

Captured 2026-11-05 on the dev compose stack with the synthetic estate (tenant
`ac9a6a65-1f19-4ecf-bf16-b3a90e42cc5c`: 2,000 hosts, 1,500 VMs, 162 listening services, 60 application components,
7,495 flows recorded by the IPFIX exporters on the core switches).

## What changed

1. **Derivation** (`apps/reconciler/src/core/adm.ts`, pure): flows (`communicates_with`) are joined with the compute
   that owns each address (`uses_ip`), the listeners on the server side (`listening_service` + `runs_on`, with the
   owning process) and the application components on both sides, into `depends_on` edges of three kinds:
   client compute → listener (confidence 0.9), client compute → server compute when no listener serves the port
   (0.6), client component → server component (0.85, or 0.6 and `ambiguous` when the client runs several). Both
   flow dialects are read: the netflow collector's address → address records and a source that already resolved its
   endpoints (an agent, the synthetic estate). Every edge carries its evidence: protocol, ports, flows, bytes,
   packets, exporters, client and server addresses, processes, first and last seen, confidence.
2. **The pass** (`apps/reconciler/src/worker/adm.ts`): new edges go through the reconciliation pipeline as a
   collector result from the `adm` source on the `reconciler` node, so they are versioned and fanned out to Memgraph,
   ClickHouse and Meilisearch through the outbox; every derived edge takes the pass's evidence, run id and kind
   confidence in one statement per batch; edges the flows no longer support are retired with the
   `openmap.relationship.retired` event; one `openmap.dependency.derived` event (event 0.6.0) summarises the pass.
   Runs after any reconciled result that carried flows, addresses, listeners or components (debounced per tenant),
   at the end of a replay, and on demand (`pnpm --filter @openmap/reconciler adm [--tenant <id>]`). Metrics
   `openmap_reconciler_adm_passes_total`, `openmap_reconciler_adm_edges_total{action}`,
   `openmap_reconciler_adm_duration_seconds`; span `reconcile.adm`.
3. **The console** (`apps/console/src/components/dependencies/ImpactPanel.tsx`, `traffic.ts`): the Dependencies side
   panel lists the focus CI's observed traffic, busiest first: what it talks to and what talks to it, protocol and
   ports, flows and bytes, the process, the last-seen instant, the confidence and the ambiguity note. The edges are
   ordinary `depends_on` edges on the map and in the impact query, so blast radius follows observed traffic.

## On the dev estate

| Pass | Flows read | Derived | Created | Refreshed | Retired | Duration |
| --- | --- | --- | --- | --- | --- | --- |
| first | 7,495 | 7,587 (7,434 listener, 148 component, 5 compute) | 7,587 | 0 | 0 | 2.7 s |
| second | 7,495 | 7,587 | 0 | 7,587 | 0 | 0.7 s |

Examples derived (busiest component edges): `aml-web → aml-api` tcp/8443 via java, 25.2 M flows;
`aml-api → aml-db` tcp/1521 via tnslsnr, 14.4 M flows; `aml-api → iam-sso-api` tcp/8443, 14.5 M flows. Busiest
listener edges: `api-ryd-aml-03 → api-ryd-iam-sso-01 tcp/8443`, 2.0 M flows.

## Tests

| Id | What | Result |
| --- | --- | --- |
| T-149 | `apps/reconciler/src/core/adm.test.ts`: listener match with process, compute fallback, component mapping and ambiguity, aggregation across flows, both endpoint shapes, noise / self-flows / unowned addresses, determinism | 6 of 6 |
| T-150 | `apps/reconciler/src/worker/adm.integration.test.ts` against Postgres with the estate: derives with the right provenance and confidences, a second pass is idempotent, a vanished flow retires its edge with the event and returns with the flow | 2 of 2 |
| T-151 | `apps/console/src/components/dependencies/traffic.test.ts` and `DependenciesView.test.tsx` (en, ar): derived edges told from asserted ones, direction, ordering, byte units, the panel section with its evidence | 14 of 14 (dependencies suite) |
| T-152 | Playwright `apps/console/e2e/dependencies.spec.ts` (en, ar): the focus search finds a web host of the estate, the panel lists its observed traffic with protocol and ports, the java process and the 90 % confidence | see below |

Also green: `pnpm guard`, `pnpm i18n:check` (9 new keys per locale), `pnpm contracts:check`, console lint, the
reconciler unit suite (27). Lighthouse: not re-measured (the Dependencies screen's budgeted paths are untouched; the
panel section renders from the same CI detail query).

## Screenshots

- `console/dependencies-traffic-en.png`, `console/dependencies-traffic-ar.png`: the Dependencies screen focused on
  `web-dmm-cards-02` with the observed-traffic section of the side panel.
