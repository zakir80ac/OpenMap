# ADR-019 — Scenario kinds are the what-if conditions

Status: Accepted · Date: 2026-11-04 · Tracker: REQ-BSM-003, REQ-UI-013 · Contract: impact 1.0.0

## Context

Running any what-if model from the Business services › Impact modeling screen ended in "Something went wrong".
The API answered every `saveScenario` with `invalid ScenarioInput`: the impact contract's `SCENARIO_KINDS` listed
failure scopes (`component`, `power`, `rack`, `site`, `network`, `storage`, `cloud_region`, `shared_service`,
`maintenance`), drafted before the console existed, while the console (REQ-UI-013) sends the condition the operator
picked (`failed`, `degraded`, `power_loss`, `link_down`, `certificate_expired`, `warranty_expired`,
`subscription_expired`, `end_of_life`, `vulnerability_exploited`, `capacity_exhausted`). The zod enum rejected it,
and the API's severity rule (`maintenance` degrades, everything else is down) ignored the console's own severity per
condition, so even an accepted kind would have simulated the wrong state. The console unit test stubbed the API and
could not see the disagreement; no e2e ran a model on the real stack. The generic error hid the server's reason.

## Decision

- **One vocabulary.** `SCENARIO_KINDS` is the list of conditions plus `maintenance`; `SCENARIO_KIND_SEVERITY` maps
  each to the state it starts the components in (`down`, `degraded`, `at_risk`), with `Record<ScenarioKind, …>` so a
  new kind without a severity fails to compile. The console's `IMPACT_CONDITIONS` *is* `SCENARIO_KINDS` and its
  condition table takes severity from the map; the API's `severityFor` reads the map. Scope kinds are dropped: the
  scope of a scenario is its component list, not a tag.
- **Maintenance window becomes a condition** the picker offers for every component (degraded), since the engine and
  contract already supported it.
- **Impact contract 1.0.0** (enum members removed, so a major bump per CONTRACTS.md). The GraphQL schema is
  unchanged (`ScenarioInput.kind: String!`). Postgres enum `ScenarioKind` is recreated by migration 0012; existing
  rows map `power → power_loss`, `network → link_down`, `maintenance → maintenance`, anything else `→ failed`.
- **Validation errors say why.** `parseInput` puts the zod issues in the message, so a GraphQL client sees
  `invalid ScenarioInput: kind: Invalid option …` instead of the bare label, and the impact screen prints the server's
  message under its error card.
- **Containment propagates for logical containers.** The traversal never followed `contains`, so an application
  component's failure never reached its application and therefore no business service, and a host's failure stopped
  at the application components running on its VMs: every scenario reported nothing affected. `contains` joins
  `GRAPH.impactEdgeTypes`, gated in the query on the container's type (`GRAPH.impactContainerTypes`: application,
  k8s_namespace, k8s_cluster) so a switch is never taken down by one of its interfaces. `communicates_with` stays out:
  it carries no direction of dependency. The scenario's `runbook` gains its column (migration 0013); the contract had
  it from the start and every scenario read failed its parse without it.
- **T-122** runs a model end to end on the compose stack in both locales and asserts no error card and a saved,
  re-runnable scenario.

## Consequences

- Anything that built scenarios with the old scope kinds must send a condition; nothing in the repository did.
- A future scope dimension (rack, site, power domain) is a scenario option that expands the component list, not a kind.
