# ADR-047 — Impact prediction accuracy: incidents validate simulations, misses suggest relationships

Status: Accepted (REQ-BSM-004, 2026-11-08) · Date: 2026-11-08 · Tracker: REQ-BSM-004, REQ-BSM-003, REQ-UI-013

## Context

REQ-BSM-004 (docs/CAPABILITY-MAP.md §5): "Every real incident is compared with simulations; misses become new
relationships (`impactValidationSchema`)".

- The contract had `impactValidationSchema` and migration 0001 had an `impact_validations` table. Nothing wrote either.
- Simulations exist only when a person saves and runs a what-if scenario (REQ-BSM-003). Most incidents have none to be
  compared with.
- The impact traversal (`impactQuery`, packages/graph) reaches business services only through a `part_of_service` hop
  from a node of the closure. An edge that does not end in `part_of_service` cannot make a simulation predict a service.
- Incidents are resolved in two places: the BSM engine when health recovers, and the API when a person resolves or
  closes one. The API alone holds the simulation inputs: service models, facts and health (`BsmFactsService`).
- None of the synthetic estate's incidents named a root cause (`rootCauseCiId` was null on all 3,850), so there was
  nothing to measure on a dev stack.

## Decision

1. **What is compared.**
   - Every incident in state `resolved` or `closed` that names a root cause (`incidents.rootCauseCiId`, which an RCA
     update also sets) is validated once.
   - It is compared with the latest saved what-if simulation of exactly that root cause run before the incident opened.
     That is the person's own prediction.
   - Failing that, it is compared with a replay simulation:
     - kind `failed`, the whole upstream closure (`maxDepth` 0), redundancy honoured;
     - stored as a scenario of the new origin `incident`;
     - run over the graph as it stands at validation. A sweep validates within a minute of resolution, so this measures
       the model people now rely on. A replay at the incident's opening would also read nothing on an estate replayed
       after its history.
   - Predicted services are those predicted `down` or `degraded`; `at_risk` ones kept running.
   - Accuracy is the Jaccard similarity of predicted and actual services (`compareImpact`; two empty sets agree).
     `missed` names what the incident hit and the model did not predict; `unexpected` names what the model predicted and
     the incident spared.
2. **Misses become suggestions, not relationships.**
   - Each missed service becomes a `relationship_suggestions` row (migration 0032): root cause `part_of_service` missed
     service. That is the edge the traversal follows into services, so once it exists the next failure of that root
     cause predicts the service.
   - A suggestion is skipped when the relationship already exists, or when the service is the root cause itself.
   - A repeated miss adds to `occurrences`.
   - An operator accepts it, which creates the relationship as a person's edit (`CiService.createRelationship`, with
     user-label confidence, through the outbox), or dismisses it.
   - A decided suggestion is never reopened, so a dismissed miss is not suggested again.
   - One incident is weak evidence for a dependency, so nothing is written to the graph without a person.
3. **When.**
   - The API runs a sweep every `IMPACT_VALIDATION_INTERVAL_MS` (config, default 60 s; 0 turns it off).
   - Each sweep takes at most `IMPACT.sweepBatch` (50) incidents per tenant, oldest resolution first. A backlog drains
     over several ticks without one long transaction.
   - `validateImpactPredictions(limit)` runs a sweep for the caller's tenant on demand, and
     `validateImpactPrediction(incidentId)` re-validates one incident.
   - The sweep sits in the API because the simulation inputs are assembled there. The BSM engine would need a second
     copy of `BsmFactsService`.
4. **Replays stay out of the saved list.** `impact_scenarios.origin` (`user` or `incident`, default `user`) keeps
   incident replays out of `impactScenarios`; they are reached through their validation.
5. **Contracts.** These are additions only:
   - Impact contract: `SCENARIO_ORIGINS`, `ImpactScenario.origin`, `IMPACTED_STATES`, `compareImpact`,
     `SUGGESTION_STATES`, `SUGGESTION_REASONS`, `relationshipSuggestionSchema`, and the JSON Schemas `impact-validation`
     and `relationship-suggestion`.
   - GraphQL 1.19.0: `ImpactScenario.origin`, `ImpactValidation`, `ImpactAccuracy`, `RelationshipSuggestion`, queries
     `impactAccuracy` and `relationshipSuggestions`, and mutations `validateImpactPredictions`,
     `validateImpactPrediction`, `acceptRelationshipSuggestion` and `dismissRelationshipSuggestion`.
   - No event type is added: a validation emits `openmap.audit.action` (`impact.validated`), and an accepted suggestion
     emits the existing `openmap.relationship.created`.
6. **Observability.**
   - `openmap_impact_validations_total{outcome}` counts each validation as `exact`, `partial` or `failed`.
   - `openmap_impact_prediction_accuracy` is a histogram of the accuracy each validation scored.
   - Each validation runs in an `impact.validate` span.
7. **Synthetic root causes.** `replay-history` names a root cause for every replayed incident, picked deterministically
   from the service name and the outage start. It is one of the components, database clusters, VMs, hosts and
   hypervisors the service's applications depend on (`SLA.synthetic.rootCauseTypes`).

## Consequences

- **Accuracy on the dev stack measures over-prediction.** A synthetic incident hits one service, while a component
  shared by several applications predicts all their services.
- **Real misses come from real incidents.** They come from the BSM engine and from people's RCAs, where an incident
  hits services no modelled path reaches. T-466 covers that path end to end on the compose stack: the miss, the
  suggestion, accepting it, the edge in Memgraph, and a second incident predicted without a miss.
- **Old incidents are judged by today's graph.** An old incident validated now, such as the replayed history, is judged
  by the current graph. The validation records when it ran (`validatedAt`), and an incident can be re-validated.
- **Replay scenarios accumulate,** one per incident without a prior simulation. `replay-history --reset` removes them
  with the incidents. Their simulations cascade with the validations.
