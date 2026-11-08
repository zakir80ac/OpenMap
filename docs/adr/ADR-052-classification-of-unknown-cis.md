# ADR-052 — Classification of unknown CIs: fingerprints, suggestions and the user label

Status: Accepted (REQ-AI-002, 2026-11-08) · Date: 2026-11-08 · Tracker: REQ-AI-002 · Contract: GraphQL 1.24.0

## Context

- **What a port scan leaves.** It finds devices no collector recognises: cameras, printers, phones, signage,
  building-management controllers, UPS cards. Each becomes a CI of type `unknown` in the `unknown` layer, carrying the
  scan's evidence: the SNMP `sysDescr`, the HTTP banner, the vendor the MAC's OUI names, and the open ports.
- **What REQ-AI-002 asks.** Suggest a type and layer from that evidence, let a person confirm it, show the suggestions
  on the Layers screen, and track how many are accepted.
- **What the CI contract already has.** A user label (`userLabel`: title, description, layer and an optional
  reclassified type), written by `labelCi`. The CI's effective layer is the label's layer.
- **The missing types.** The CMDB has no CI type for most of these devices.

## Decision

1. **The label, not new types.** A suggestion is a user label in waiting: its class (printer, network camera, IP
   phone …), its layer, and the CMDB type only where one fits:
   - a UPS management card is `ups`;
   - a wireless access point is `network_device`;
   - a Raspberry Pi gateway is `host`.

   The rest keep `unknown` as their type and take the suggested layer:
   - building systems, cameras and access control go to `dc`;
   - endpoints go to `hardware`.

   No CI type, identity rule or collector contract changes.
2. **Fingerprints as data (`DEVICE_FINGERPRINTS` in `@openmap/constants`).** For each class:
   - case-insensitive patterns over sysDescr, banner and vendor, naming product families and protocols rather than
     models;
   - the class's well-known ports.

   Evidence is weighted (`CLASSIFICATION.weights`): sysDescr 0.5, banner 0.15, vendor 0.15, and ports 0.2 shared
   across the class's ports. Below `minConfidence` (0.4), nothing is suggested, so a vendor or a port alone proves
   nothing.
3. **A pure classifier (`classifyCi` in `@openmap/assistant`)** returns the best class with its evidence (signal,
   matched text, weight) and the label's title and description. The title is the device's own sysDescr; the
   description is the evidence.
4. **Suggestions in Postgres (`classification_suggestions`, migration 0037)**, one per CI.
   - A sweep classifies the tenant's unknown, unlabelled CIs (up to `CLASSIFICATION.sweepLimit`) when the Layers screen
     asks.
   - **Accepting** writes the label through `CiService.labelCi`: outbox event, graph and the asset register for an
     owned type, as a person's label would.
   - **Dismissing** keeps the row, so the same evidence is not suggested again.
   - **New evidence** on the CI (a different `evidenceKey`) opens a new suggestion.
   - **Acceptance rate:** accepted / (accepted + dismissed), per tenant. `openmap_classification_suggestions_total`
     counts suggested, accepted and dismissed.
5. **GraphQL 1.24.0.**
   - Query `classificationSuggestions`: the open suggestions with the unrecognised count and the acceptance rate.
   - Mutations `acceptClassificationSuggestion` and `dismissClassificationSuggestion`, for operators.
   - Types `ClassificationSuggestion` and `ClassificationEvidence`.
6. **Layers screen.** A panel lists each suggestion: the CI, class, layer, type, confidence, the device's own title and
   the evidence. Operators get Accept and Dismiss.

## Results

- Over the 290 unknown CIs the synthetic estates hold (12 device kinds), the suggested class matches the device the
  generator placed in every case. The generator's `deviceKind` is ground truth, and the classifier never reads it
  (T-499).
- Seven models the fingerprints were not written from are recognised by family and protocol, and a vendor or a port
  alone gives no suggestion (T-498).

## Consequences

- **Data, not code.** A device family the fingerprints miss stays in the unrecognised count for a person to label by
  hand. Adding a fingerprint is a constants change with a test, not a model retrain.
- **No LLM.** Explanations are the evidence itself: every point of the confidence is a pattern match or a port the
  person can check. REQ-AI-003 (anomalies) is where an LLM explanation is planned.
- **Labels, not types.** A device classed without a CMDB type keeps type `unknown` under a label. It is out of the
  `unknown` layer but cannot be filtered by a type of its own until the type model grows. A new type would need its own
  ADR.
