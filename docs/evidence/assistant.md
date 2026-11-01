# Assistant — NL→Cypher golden set (REQ-AI-001)

Captured 2026-11-01 on the dev compose stack: Memgraph with the synthetic estate (tenant
`ac9a6a65-1f19-4ecf-bf16-b3a90e42cc5c`, 32k current CIs) and the `cpu` LLM profile running
`Qwen2.5-Coder-1.5B-Instruct` (q4_k_m) on llama.cpp. Test file: `apps/assistant/src/core/golden.integration.test.ts`
(T-113, `pnpm --filter @openmap/assistant test:integration`); unit coverage of the pipeline: T-011
(`apps/assistant/src/core/assistant.test.ts`, 17 cases); console: T-104 and the e2e Assistant test.

## Why the assistant was failing

Every question ended in `the query failed to run: Unbound variable: n`. The grounding prompt contained the fragment
`WHERE n.tenantId = $tenantId` and an impact pattern with `{name:$name}`; the 1.5B model copied both verbatim into
queries that never bound `n` and used a parameter that does not exist. The repair loop fed the engine's error back,
but the model repeated the fragment. Probing the live model with the old prompt reproduced it on three of four
questions.

## What changed

- **Prompt** (`grounding.ts`): no fragments. Six complete worked examples, each validated by the unit tests against the
  pipeline's own validator; the relationship directions as the reconciler stores them (`KNOWN_DIRECTIONS`); the exact
  health values; a statement that measurements (utilisation, power, CPU) are not graph properties.
- **Deterministic pipeline** (`nl2cypher.ts`, `prepareCypher`): extraction → hop normalisation (a reversed known hop is
  turned round, a wrong type between two labels linked by exactly one type is replaced) → tenant scoping (every node
  variable a MATCH binds gets `tenantId = $tenantId` and `validTo IS NULL`, added to the clause's WHERE) → LIMIT.
- **Validator**: unbound variables (`variable n is used but never introduced in a MATCH pattern; the query binds s`),
  unscoped node variables, unknown parameters, unknown labels, relationship types and node properties, backwards hops,
  health literals outside `healthy | degraded | down | unknown`. Each rejection names the fix, so the repair loop has
  something a small model can act on, and the final refusal shown to the user says why.
- **Contract (TypeScript only)**: `HEALTH_STATES` / `healthStateSchema` in `@openmap/contracts` mirror the GraphQL
  `HealthState` enum, so the prompt and the validator share one source. No wire change.
- **Compose**: `llm-cpu` carried the image's health check against llama.cpp's default port while the server listens
  on 8000; the container had been "unhealthy" for 499 checks. An explicit check on `/health` replaces it.

## Golden set — 12 of 12 pass (run 4, 39.6 s)

| Question | Outcome | Rows |
| --- | --- | --- |
| How many hosts are there? | answered | 1 |
| How many hosts run each operating system? | answered | 200 (LIMIT) |
| Which business services are degraded right now? | answered | 0 |
| Which business services are down? | answered | 0 |
| List the virtual machines and the hypervisor each one runs on | answered (RUNS_ON normalised to HOSTED_ON) | 200 (LIMIT) |
| Which racks hold the most hosts? | answered | 94 |
| Which racks draw the most power? | refused: `property powerDraw does not exist on nodes …` | 0 |
| Which subnets are more than 70% used? | refused: `property utilisation does not exist on nodes …` | 0 |
| Which software is affected by a vulnerability? | answered | 200 (LIMIT) |
| How many network devices are in each site? | answered | 1 |
| Which applications are part of the most business services? | answered (reversed PART_OF_SERVICE turned round) | 17 |
| Count the CIs per layer | answered | 11 |

The two refusals are correct: utilisation and power draw are attributes the API serves from Postgres (IPAM and DCIM
screens), not node properties in the graph, and the assistant says so instead of returning "no matching items". The
zero rows for degraded and down services agree with the API's `services` query, which reports all 15 business
services as `unknown` on this stack (the BSM engine has had no CI health events to propagate since the estate replay).

Runs 1–3 of the same set, before each fix: 9/12 (prompt + scoping + unbound check), 10/12 (schema checks), 12/12
(hop normalisation). Before any change: 0 of 4 console example questions answered.

## Console

The four example prompts on the Assistant screen are now all answerable from the graph (`assistant.example.subnets`
asks which subnets hold the most IP addresses, `assistant.example.power` which PDUs power the most hosts); the
previous two asked for utilisation and power draw and were always refused. Screenshots: `console/assistant-en.png`,
`console/assistant-ar.png`.
