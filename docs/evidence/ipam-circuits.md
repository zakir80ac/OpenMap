# Network circuits (REQ-IPAM-007, ADR-069)

Captured 2026-11-10 on the dev compose stack (TLS-only Postgres, ClickHouse over HTTPS, Memgraph, the running
reconciler), with host-side tests run one file at a time against `deploy/compose/.env`.

## What was missing

Inter-site links (`site_link` CIs, ADR-017/025) and carrier circuits (`circuit` CIs, ADR-056) existed, but:

- the two were not related, so a circuit outage reached nothing in the impact graph;
- the carrier contract and committed latency could not be recorded;
- a diverse-path claim was never checked;
- an unprobed link had no health;
- losing one link of a pair raised nothing;
- readiness incidents named no service.

## What was built

| Part                        | Where                                                                                                                                      | What it does                                                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract                    | `packages/contracts/src/connectivity.ts`                                                                                                   | `LINK_ROLES`, `LINK_CIRCUIT_RELATIONSHIP` (`depends_on`), `LINK_SHARED_RISK_KINDS`, `linkCircuitInputSchema`, `riskKey`, the register's attribute names, the rules `path_diversity` and `redundancy_lost`                                                             |
| Constants                   | `packages/constants` `LINK_CIRCUITS`, `READINESS.severity`, `CONTRACT_VERSIONS.graphql` 1.41.0                                              | Circuits per link (8), diverse paths (16), reference length (128), the hand-off CI types; severities low and medium                                                                                                                                                   |
| Setup record                | migration `0046_site_link_circuits`, `site_links.carrierContractRef` / `slaLatencyMs` / `pathRef`                                          | The wizard records the contract, committed latency and route; the link CI carries them                                                                                                                                                                               |
| Circuit register            | `apps/api/src/connectivity/link-circuits.*`, mutation `saveLinkCircuit` (operators)                                                         | Writes kind, carrier, contract, bandwidth, latency, diverse paths, role, route and carrier circuits on the link CI. Each circuit is a `depends_on` edge, and the edges are replaced on save. The setup record follows. Audited, traced and counted                   |
| Read model                  | `ConnectivityService`, `ConnectivityLink.carrierContractRef` / `pathRef` / `circuits` / `sharedRisks`                                       | Each link's carrier circuits, with their CI and health, and what it shares with the other links between the same sites                                                                                                                                               |
| Rules                       | `apps/bsm-engine/src/core/circuits.ts`, `service/readiness.ts`                                                                             | A circuit's health comes from itself and its hand-off ports. An unprobed link takes its health from its circuits, in series. `path_diversity` raises the backup of a pair that shares a provider, route or circuit. `redundancy_lost` raises a down link of a multi-path pair, and its incident names the services the impact graph reaches |
| Engine                      | `engine.ts` `healthFromReadiness`                                                                                                          | A link whose register names circuits is not re-scored from attributes on CI events                                                                                                                                                                                   |
| Screen                      | `apps/console/src/components/sites/SitesView.tsx`, `LinkCircuitForm.tsx`, setup `ConnectivityStep.tsx`                                     | The contract, route, carrier circuits with health and shared risks per link; the two rules with their findings; an operator's circuit details form (circuits picked from the Cabling tab's records); three more wizard fields. en and ar                            |
| Telemetry                   | spans `connectivity.link_circuit.save`, `bsm.readiness.circuits`; metrics `openmap_link_circuit_changes_total{op}`, `openmap_bsm_readiness_findings_total{change,rule}` | The new write path and the new evaluation path are traced and counted                                                                                                                                                                                                |

## Tests

| Test  | Type        | File                                                          | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                       | Result                                     |
| ----- | ----------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| T-590 | unit        | `apps/bsm-engine/src/core/circuits.test.ts`                   | Site pairs in either direction. Shared provider, route and circuit, ignoring case and space; no overlay is compared. `path_diversity` raises the backup, and each later link once. `redundancy_lost` raises only where there was more than one path, counts paths left up, and counts a dual-path link. A circuit is taken down by its hand-off. A link takes the worst of its circuits, in series                                  | 12 / 12 passed (10 ms)                     |
| T-591 | integration | `apps/bsm-engine/src/service/circuits.integration.test.ts`    | Real Postgres and ClickHouse. Two unprobed links ride carrier circuits and take `healthy` from them. A shared carrier opens a low `path_diversity` finding on the backup. The fibre's hand-off interface goes down, so the fibre goes down and `redundancy_lost` opens a medium incident naming the service reached from the link. When the port recovers and the backup moves to another carrier, both clear and resolve           | 1 / 1 passed (337 ms test, 2.3 s run)      |
| T-480 | integration | `apps/bsm-engine/src/service/readiness.integration.test.ts`   | Updated for the new rule. A replication link down between two sites now also opens `redundancy_lost`: three findings, then three cleared                                                                                                                                                                                                                                                                                             | 1 / 1 passed (631 ms test)                 |
| T-592 | integration | `apps/api/src/connectivity/link-circuits.integration.test.ts` | Full API over GraphQL with an operator JWT. The setup link stores contract, latency and route on its record and CI. `saveLinkCircuit` puts it on two circuits: two `depends_on` edges, register attributes, and the record follows. Saving with one circuit retires the other edge and keeps the first. A non-circuit and a non-link are refused. A backup on the same carrier and circuit shows both shared risks on both links. After the reconciler writes Memgraph, the impact walk from the shared circuit reaches both links. Three audits | 1 / 1 passed (1.64 s test, 9.95 s run)     |
| T-593 | unit (UI)   | `apps/console/src/components/sites/LinkCircuitForm.test.tsx`  | In en and ar: the new rules with findings and incident; contract, route, circuit tag and shared-risk line on the link row. An operator edits contract, route and latency, adds a second circuit and saves, and `saveLinkCircuit` receives the full entry. The draft helpers refuse missing figures                                                                                                                                  | 3 / 3 passed                               |
| T-481 | unit (UI)   | `apps/console/src/components/sites/SitesView.test.tsx`        | Updated: five rules (three passing), and no edit control for a viewer who is not an operator                                                                                                                                                                                                                                                                                                                                         | 2 / 2 passed                               |
| T-594 | e2e         | `apps/console/e2e/circuits.spec.ts`                           | Written, not run. Per locale (en, ar), on the real estate: record an E2E circuit, give the first link a contract, route and latency and the circuit from the Sites screen, and check the row and the API. Then restore the link and remove the circuit (leftovers are swept). Screenshot `circuits-<locale>.png`                                                                                                                    | not run (written)                          |

Suites around the change:

| Package           | Unit result                 |
| ----------------- | --------------------------- |
| apps/bsm-engine   | 13 files, 78 tests passed   |
| apps/api          | 13 files, 54 tests passed   |
| apps/console      | 66 files, 387 tests passed  |
| packages/contracts | 25 files, 110 tests passed |
| packages/db       | 7 files, 91 tests passed    |

Other checks:

- `pnpm turbo run typecheck`: 34 of 34 tasks.
- `pnpm --filter @openmap/console lint`: clean.
- `pnpm contracts:check`: "GraphQL schema 1.41.0 ok against HEAD". It reports only "dangerous" optional input fields
  added to `SiteLinkInput`.
- `pnpm i18n:check` (en, ar in sync).
- `pnpm guard`: ok.

Integration runs on this shared dev stack sometimes failed before reaching any assertion, with Prisma
"Timed out fetching a new connection" or `ECONNRESET` errors. The cause was Docker Desktop port forwarding under
several agents' concurrent load. Each such run passed on retry, unchanged. The organizations those runs left behind were
removed.

## Not covered here

- **The e2e spec is written but not run.**
- **No RTL screenshot was taken.** T-594 writes one when it runs.
- **A simulated circuit outage that honours redundancy does not carry the outage through the link.** It keeps the
  live health of the components between the circuit and a service, as for any intermediate component (ADR-019). The
  live path (circuit, link health, services) is covered by T-591 and T-592.
