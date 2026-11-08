# ADR-054 — Cloud recommendations: rightsizing and unused resources

Status: Accepted (REQ-AI-005, 2026-11-08) · Date: 2026-11-08 · Tracker: REQ-AI-005 · Contract: GraphQL 1.26.0

## Context

REQ-AI-005 asks for an analytics model over cloud utilisation and cost that finds what to rightsize and what is
unused. The cloud collectors (AWS Config, Azure Resource Graph) record each resource's type, state, SKU, monthly cost
and tags on its CI, and sample its load as `cloud.resource.load_percent`.

## Decision

1. **A pure model (`recommendCloud` in `@openmap/assistant`, thresholds in `CLOUD_ADVICE`):**
   - **Release:** a stopped resource that still costs money. Its saving is its monthly cost; attached disks, reserved
     addresses and licences keep billing while it is stopped.
   - **Decommission:** running compute whose peak load stays at or under 5%. Its saving is its monthly cost.
   - **Downsize:** running compute whose peak stays at or under 40% and average at or under 30%. Its saving is half its
     monthly cost, because one size step down within an instance family halves the price on the major clouds.
   - **Upsize:** running compute averaging 85% or more, the utilisation register's hot line. It has no saving; it is
     headroom.
   - **Compute** means EC2 instances, RDS instances, Azure VMs, Azure SQL databases and App Service apps. Functions,
     queues, networks and keys have no size to change, so only the stopped rule applies to them.
2. **Load:** the samples of the last 14 days (average and peak), or else the latest sample. Every recommendation shows
   the sample count and the newest sample's time, so a judgement made on one old sample is visibly so.
3. **Computed on request (`cloudAdvice`):** nothing is stored, so the advice follows the estate as collectors report it.
   `openmap_cloud_recommendations_total` counts recommendations by kind, and a `cloud.advise` span covers each request.
4. **Screen:** a panel on the Utilisation screen lists each advised resource with:
   - its advice and saving;
   - its cost, load, owner and environment;
   - the total monthly saving.

## Results

On the scale-1 estate (258 cloud resources), the model gives 39 recommendations worth an estimated $83,663 a month:

| Advice | Count |
| --- | ---: |
| Release | 20 |
| Downsize | 16 |
| Decommission | 2 |
| Upsize | 1 |

T-507 covers the model, T-508 the stores, T-509 the panel and T-510 the e2e test.

## Consequences

- **The savings are estimates.** They take the monthly cost the collector reports at face value, and assume the
  half-price step within a family.
- **No reservations or savings plans.** The model does not read reserved instances or savings plans, so a reserved
  instance's saving is overstated. A pricing integration would refine it.
- **No accept or dismiss.** The advice is a report. Acting on it happens in the cloud console or through IaC, which
  REQ-INT-013 will cover.
