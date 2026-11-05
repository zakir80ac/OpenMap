# The layered application map (REQ-DEP-004, ADR-031)

Captured 2026-11-05 on the dev compose stack with the synthetic estate (22 applications, 60 components in web, api,
db and infra tiers, placed on VMs, hosts and Kubernetes workloads; 148 component dependencies derived from traffic
by ADR-029).

## What changed

1. **API** (`apps/api/src/graph/application-map.ts`, `application-map.service.ts`): `applicationMap(id)` (GraphQL
   1.7.0) returns the application, its business services, its components by tier in `APPLICATION_MAP.tierOrder`,
   every placement reachable through `runs_on`/`hosted_on` with its parent and hop, and every dependency touching a
   component classified internal, outbound or inbound with the far end's application and, for a derived edge, its
   protocol, ports, flows and confidence. Span `application_map`, histogram
   `openmap_application_map_duration_seconds`.
2. **Console** (`apps/console/src/components/dependencies/ApplicationMapView.tsx`, `application-layers.ts`): the
   Dependencies screen's third view (`view=application`): an application picker; a grid whose columns are the
   components by tier and whose rows are the layers (applications, then each placement layer in CI_LAYERS order);
   layer chips hide rows; the application and hidden layers are in the URL; the panel lists the dependencies inside
   the application, to other applications and stores, and from other applications, marked "observed in traffic" or
   "recorded by discovery", with a link to the application's impact map.

## On the dev estate: `aml`

Three tiers (aml-web on NGINX 1.26, https/443, 4 instances; aml-api on Spring Boot 3.3, https/8443, 6 instances;
aml-db on Oracle, tcp/1521), part of Mobile Banking, Money Markets and ATM Network. The virtualization row shows the
VMs of each tier and the hypervisor under them; the hardware row shows the physical hosts. Ten dependencies: two
inside the application (aml-web → aml-api tcp/8443, 25.2 M flows; aml-api → aml-db tcp/1521, 14.4 M flows), eight to
other applications and stores (iam-sso-api for authentication, infra-monitoring and infra-dns, the aml-ryd-ora
cluster recorded by discovery). Query 21 ms.

## Tests

| Id | What | Result |
| --- | --- | --- |
| T-157 | `apps/api/src/graph/application-map.test.ts`: tier order with unknown tiers last, grouping, direction classification with the far application, derived evidence against asserted provenance, unrelated edges dropped | 2 of 2 |
| T-158 | `apps/api/src/graph/application-map.integration.test.ts` through GraphQL against the estate: tiers in order, direct and deeper placements under components, derived internal dependencies with ports and flows, confidences in range, null for a host id | 2 of 2 |
| T-159 | `apps/console/src/components/dependencies/ApplicationMapView.test.tsx` (en, ar): the placement walk, the URL-driven application and hidden layers, the grid with tiers, technology, ports and placements by layer, the dependency sections with their evidence, the not-an-application message | 7 of 7 |
| T-160 | Playwright `apps/console/e2e/application-map.spec.ts` (en, ar): switch to the application view, choose `aml`, tiers web before db, virtualization row present, derived internal dependency listed, hiding the layer removes its row | 2 of 2 (7 of 7 with the topology and dependencies specs) |

Also green: `pnpm guard`, `pnpm i18n:check` (22 new keys per locale), `pnpm contracts:check` (1.7.0 additive),
console lint.

Not covered: no component in the dev estate runs on a cloud resource, so no test draws a cloud row (ADR-031).

## Screenshots

- `console/application-map-en.png`, `console/application-map-ar.png`: the `aml` application with its tiers, layers
  and dependencies.
