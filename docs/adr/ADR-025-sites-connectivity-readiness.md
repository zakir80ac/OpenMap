# ADR-025 — Sites and connectivity: continuous link probes and HA / DR readiness rules

Status: Accepted (REQ-BSM-007, 2026-11-08) · Date: 2026-11-08 · Tracker: REQ-BSM-007

## Context

Syed (2026-11-05): "Sites and their connectivity: multiple sites, inter-site links monitored continuously for HA / DR
readiness." REQ-BSM-007's acceptance:

- every site and inter-site link is shown with live health;
- Discovery Nodes probe the links continuously (reachability, latency, loss), and the results land in ClickHouse and
  on the link CI;
- readiness rules (diverse paths per tier-1 site, DR site reachable, replication links healthy) are evaluated
  continuously, and breaches open incidents.

What existed:

- Sites and links are setup records (`sites`, `site_links`, ADR-017). Each has a CI: `site` (identity `code`) and
  `site_link` (identity `circuitId`, `fromSiteRef`, `toSiteRef`), joined by `connected_to` A/Z relationships.
- The synthetic estate generates these CIs, but not the setup records.
- `Site.tier` is the Uptime Institute tier of the facility. Nothing marked a site's business criticality or its DR
  role.
- No collector measured latency, and no job recurred: the scheduler plans one-shot sweeps on demand.
- Collector samples already reach ClickHouse `metrics` and `metrics_latest` through the reconciler (ADR-016).
- The BSM engine derives CI health from attributes and opens incidents keyed by business service.

## Decision

1. **Site and link attributes.** The rules read CI attributes, so they work the same for set-up and discovered
   estates. The setup wizard writes them onto the CIs; the synthetic estate generates them.
   - **Site CIs carry `drRole`** (`primary`, `dr` or `none`).
   - **Site CIs carry `criticality`** (1 = most critical … 3), the business tier. "Tier-1 site" in the acceptance means
     criticality 1. The facility's Uptime tier stays `tier`.
   - **Link CIs carry `replication`** (true for a link that carries storage or database replication) and
     **`probeTarget`** (`host` or `host:port`): what a Node at the link's A end connects to at the Z end.
   - The setup records gain the same fields (migration 0034): `sites.drRole`, `sites.criticality`,
     `site_links.replication`, `site_links.probeTarget`.
2. **The `link_probe` collector** (Go, `apps/collectors/cmd/link_probe`).
   - One target per link: value `host[:port]`, and `label` = the link CI id.
   - It makes `LINK_PROBE.attempts` TCP connections (port from the target, else `LINK_PROBE.defaultPort`), each bounded
     by a timeout.
   - Reachability is "any attempt connected". Latency is the median connect round trip of the attempts that
     connected. Loss is the failed share, in percent.
   - It emits samples on the link CI by id: `net.link.reachable` (1/0), `net.link.latency_ms` (only when reached) and
     `net.link.loss_percent`.
   - A TCP connect needs no raw-socket privilege, so the Node runs as non-root in every profile, air-gap included.
   - It emits no CI: the link CI is not re-asserted by a probe.
3. **Continuously.**
   - The scheduler runs a link-probe planner every `LINK_PROBE_INTERVAL_MS` (config, default 60 s; 0 turns it off).
   - For every tenant, each current `site_link` CI with a `probeTarget` becomes a target. Targets go to an online Node
     at the link's A-end site that offers `link_probe`, else to any online Node of the tenant that offers it.
   - A link whose job from the previous round has not finished is skipped, so a slow Node never stacks jobs.
4. **Health and readiness** (the BSM engine, on `READINESS.evaluateMs`).
   - **Link health** comes from `metrics_latest`:
     - unreachable → `down`;
     - loss ≥ `READINESS.degradedLossPercent` or latency ≥ the link's `slaLatencyMs` attribute (else
       `READINESS.degradedLatencyMs`) → `degraded`;
     - no sample within `READINESS.staleAfterProbes` intervals → `unknown`;
     - otherwise `healthy`.
   - A change is published like any CI health change, so the graph, propagation and the console see it.
   - **Readiness rules**, each producing findings per subject:
     - `diverse_paths`: a criticality-1 site with fewer than two healthy links (counting a link's `diversePaths`)
       breaches;
     - `dr_reachable`: a `dr` site that no `primary` site reaches over healthy links breaches;
     - `replication_healthy`: a replication link that is not healthy breaches.
   - A new breach opens a `readiness_findings` row (migration 0034) and an incident:
     - source `readiness`, root cause the site or link CI, no affected services;
     - severity high for `dr_reachable`, medium otherwise.
   - A cleared breach resolves its incident.
5. **API and console.**
   - GraphQL 1.21.0: `connectivity` returns sites (health, DR role, criticality, links) and links (health, latest
     latency, loss, reachable, probed at), with the readiness findings. `SiteInput` and `SiteLinkInput` take the new
     fields.
   - A Sites screen (`/sites`) shows the sites, the links with live figures, and the readiness rules with their
     breaches. It works in en and ar.
6. **Dev stack.**
   - The synthetic estate sets the attributes. Its probe targets are the far sites' WAN gateways (the `links` pool),
     which a dev stack cannot reach, so on a dev stack the links read `down` and the rules breach: that is the real
     outcome of probing them from there.
   - A TCP connect completes in the kernel, so no user-space responder could feign a latency: the simulator gets no link
     responder.
   - The healthy path is tested end to end by T-480, which writes probe samples into ClickHouse and runs the
     evaluation, and by T-477, which probes real local listeners.

## Consequences

- **Measurement:** a TCP connect round trip is not ICMP. It includes the far end's accept time, which is negligible
  against WAN latency.
- **Probe targets are configuration.** A link without a `probeTarget` is shown "not probed" and counts as not healthy
  for the rules. An unmonitored path is not evidence of readiness.
- **Job volume:** one job per probing Node per minute, carrying all of its links (1,440 job rows a day per Node). Each probe
  round deletes finished probe jobs, and their runs, older than `LINK_PROBE.retainMs` (a day); the samples stay in
  ClickHouse under its own TTL.
- **Incidents without affected services.** A readiness incident names its site or link as root cause and no
  business service. The Services screen's incident list keeps to service incidents; the Sites screen lists each finding
  with its incident.

## Amendment — facility cards, link traffic and redundancy (REQ-UI-026, 2026-11-08)

GraphQL 1.22.0 and REST 1.1.0 add the fields the Sites screen's acceptance names.

- **Site facility cards.**
  - Kind, Uptime tier, power capacity and design PUE come from the site CI's attributes. The setup wizard writes them
    (ADR-017), and so does the synthetic estate (`SITE_FACILITY_ATTRIBUTES`).
  - Measured PUE is the latest `dcim.site.pue` sample on the site CI. Without one, the card shows the design figure.
  - Racks are counted in the site's facility tree in Postgres: building, room, row and rack, walked down `located_in`
    edges. This is the CMDB's count, not the setup record's declared number.
  - Open alerts add up two things:
    - open readiness findings on the site or a link touching it;
    - unresolved incidents (open, acknowledged or mitigated) whose root cause is the site, one of its links, or a CI
      located in the site, walked up `located_in` for at most `READINESS.locationHops` hops.
    An incident counts once per site.
- **Link traffic.**
  - Throughput is the latest `net.device.throughput_gbps` sample on the link CI, which the SNMP or flow collectors
    polling the hand-off interfaces report.
  - Capacity is the link's committed `bandwidthMbps`.
  - Utilisation is their ratio. Its bar uses the subnet-utilisation thresholds.
- **Redundancy** (`linkRedundancy`, `LINK_REDUNDANCY_STATES`). The state is judged over every link joining the same two
  sites, in either direction, with each link counting its diverse paths. A link that is not down counts as up: no
  probe, or a stale one, is no sign of failure.
  - `down`: no path is up.
  - `single_path`: the sites have one path between them.
  - `degraded`: some paths are down.
  - `active_standby`: every path is up and a backup link stands by.
  - `active_active`: every path is up and there is no backup link.

