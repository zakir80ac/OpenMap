# ADR-031 — The layered application map: tiers, placements and dependencies of one application

Status: Accepted and implemented (REQ-DEP-004, 2026-11-05) · Date: 2026-11-05 · Tracker: REQ-DEP-004

## Context

Device42's "enterprise application dependency (multi-tier, cloud and on-prem)" asks for one application drawn as
its tiers, where each tier runs and what it depends on (CAPABILITY-MAP §5, "layered map with layer filters"). The
impact map of ADR-019 walks one CI's closure in layer lanes; it answers "what fails if this fails", not "how is this
application built". Since ADR-029 the reconciler derives component-to-component dependencies from observed traffic,
so the material for an application view is in the CMDB: `application contains application_component` (tier,
technology, port, protocol, deployment, instances), `runs_on` and `hosted_on` down to VMs, hosts, workloads, cloud
resources and their hypervisors, `depends_on` and `backed_by` between components and to data stores, and
`part_of_service` to business services.

## Decision

1. **A query per application.** `applicationMap(id)` (GraphQL 1.7.0, additive) returns the application, its
   business services, its components grouped into tiers in `APPLICATION_MAP.tierOrder` (unknown tiers last), every
   placement reachable from a component through `runs_on`/`hosted_on` within `APPLICATION_MAP.placementHops` (with
   its parent and hop, so a hypervisor hangs under the VM that hangs under the component), and every dependency edge
   touching a component, classified as internal, outbound or inbound with the far end's application named. A derived
   edge carries its protocol, ports, flow count and confidence from its evidence; an asserted one keeps its
   provenance confidence. Null when the id is not an application. Span `application_map`, histogram
   `openmap_application_map_duration_seconds`.
2. **The console draws it as a grid, not a graph.** The Dependencies screen's third view (`view=application`): an
   application picker, then a table whose columns are the components grouped by tier left to right and whose rows
   are the layers (applications first, then every layer the placements occupy, in `CI_LAYERS` order). Layer chips
   hide rows; the application and hidden layers live in the URL. The side panel lists the dependencies inside the
   application, to other applications and stores, and from other applications, with "observed in traffic" or
   "recorded by discovery", ports, flows and confidence, and links to the application's impact map. A grid keeps a
   multi-tier application readable where a force graph of components and their VMs becomes a cluster.
3. **Cloud and on-premises in one view.** A component on a cloud resource lands in the cloud row, one on a VM in the
   virtualization row with its hypervisor, one in a container in the containers row: the rows are the CI layers, so
   a hybrid application shows its split without a separate model.

## Consequences

- No new store and no new derivation; the map is as current as the CMDB and the last dependency-mapping pass.
- The synthetic estate places components on VMs, hosts and Kubernetes workloads but none on cloud resources, so no
  test draws a cloud row yet: the row appears from the same layer rule once a component runs on a cloud resource.
  Adding a cloud-hosted application to the synthetic estate is the follow-up that would exercise it.
- An application with more than `APPLICATION_MAP.maxComponents` components is cut and says so.
