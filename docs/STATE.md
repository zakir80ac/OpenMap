# OpenMap — build state

Read this first in every session (CLAUDE.md §2). If this file and the tracker disagree, the tracker wins.

## Last session · 2026-10-22 (marathon, checkpoint 3)

**What exists and runs**

- Monorepo per CLAUDE.md §5 (pnpm, Turborepo, strict TS, lefthook), Go workspace for `apps/node` and `apps/collectors` (Go 1.27).
- `packages/constants`, `packages/config`, `packages/i18n` (en + ar, parity-checked), `packages/contracts` (CI, collector, event, asset, impact, integration, organization; 18 JSON Schemas; GraphQL 0.1.0; twelve layers; CI short codes; `GLOBAL_IDENTITY_KEYS`), `packages/ui` (Obsidian Pro tokens and RTL components), `packages/db` (Prisma 6, 35 models, migrations 0001–0004 applied; **native Postgres migration runner** on `pg` with Prisma-compatible bookkeeping, so images and air-gapped hosts migrate without the Prisma CLI; ClickHouse DDL; Memgraph schema and triggers; 80 tests), `packages/graph` (Cypher repository on managed transactions with transient-error retry, `purgeTenant`; impact and time-travel verified live), `packages/testing`.
- `tools/tracker` (188 rows), `tools/guard`, `tools/synth-estate`, `tools/perf` (k6 impact-query budget test).
- `apps/api`: NestJS on Fastify, Mercurius; Keycloak JWKS auth; 26 unit + 12 integration tests; container image verified (`/healthz` ok, `/readyz` ready against the compose stack).
- `apps/console`: Next.js 15, en/ar, RTL. Screens: dashboard, layers, CMDB list, **dependency map** (Sigma.js + graphology WebGL, lane layout in a Web Worker, layer chips, time travel; ADR-007), **CI detail** (identity, attributes, relationships, impact, history diff, "Label this CI"), **impact modeling** (component explorer → conditions → `saveScenario`/`runSimulation` → affected services → `askAssistant`), **services** (propagated health, SLA budgets, incidents), **discovery** (Nodes, jobs, sweep, Run discovery). 74 tests, 19 routes build. Sign-in (OIDC + PKCE against Keycloak) is being added by a background session.
- `apps/scheduler`: planner, Node API (mTLS enrolment with CSR signing, heartbeat, atomic job pull, result intake with evidence, OpenBao credential resolution, results queue), `pki:init`, **`node:register`** (one-time enrolment token) and **`job:submit`** CLIs.
- `apps/reconciler`: identity resolution, confidence merge, control-character sanitising, array-based persistence (`INSERT … SELECT FROM unnest` per table), pending-relationship sweeps, outbox dispatcher (1000-row batches, bulk stream publish, ClickHouse async inserts); `replay` and `bench` tools.
- `apps/bsm-engine`: **running service** (`main.ts`): CI health rules from observations (power, link, replicas, certificates, staleness), redundancy-group propagation to business services, `openmap.bsm.health.changed` events, incidents opened / updated / mitigated / resolved, delivery to ITSM, SIEM and on-call integrations with OpenBao credentials; verified live (fault injected in Memgraph → 3 incidents → cleared → mitigated).
- `apps/assistant`, `apps/node` (Go) as before; Node now passes `evidenceDir` so collectors store raw evidence by digest.
- `apps/collectors` (Go), **25 families**, all unit-tested against protocol-shaped fixtures served in-process or typed transcripts: `snmp` (MIB-II, IF, ENTITY, LLDP, Q-BRIDGE, **UPS-MIB, APC PowerNet, Raritan PDU**), `ssh_agentless`, `ipmi_redfish`, `vmware`, `kubernetes`, `nutanix_ahv`, `kvm_libvirt`, `wmi`, `hyperv`, `port_scan`, `dns` (AXFR), `certificate`, `vulnerability_feed` (NVD 2.0), `cloud_azure` (ARM), `cloud_aws` (signed Query/REST: STS, EC2, VPC, RDS, ELBv2, EKS), `storage_pure`, `storage_ontap`, `fc_fabric` (Brocade FOS, Cisco MDS), `dhcp` (Windows, ISC, Kea), `ldap` (AD/LDAP), `database` (PostgreSQL, MySQL, SQL Server, MongoDB, Redis; live-probed against the compose Postgres and Valkey), `object_storage` (S3-compatible, SigV4 known-answer tested), `load_balancer` (F5 iControl REST), `oracle_vm` (oVirt/OLVM/RHV), `netflow` (v5, v9, IPFIX, sFlow). Shared runners: `sshexec`, `winrmexec`, `restjson`, `sigv4`.
- **End-to-end discovery verified on the dev stack**: `pki:init` → scheduler → `node:register` → Go Node enrolled over mTLS → `job:submit` port_scan and certificate → results through the queue → reconciler → Postgres and Memgraph (SECURED_BY edge visible), evidence stored on the Node.
- `deploy/`: `docker/node-service.Dockerfile` (api, scheduler, reconciler, bsm-engine; all build) and `docker/node.Dockerfile` (Node + 25 collectors, distroless, 190 MB); `compose/docker-compose.apps.yml` overlay with a migrations job; air-gap overlay and `airgap-bundle/` build/load scripts; `helm/openmap` chart (in-chart datastores, Keycloak, OpenBao or external, services, migrations hook, ingress; lints and renders). `deploy/README.md` documents all three profiles.
- Design: 13 screens on the Obsidian Pro canvas: https://claude.ai/artifact/VcFmJuAaHCmrvgpPMmTzrf.

**Throughput (REQ-CORE-013 / REQ-PERF-003), scale-0.05 estate = 28,200 CIs, 66,332 relationships, 2,246 devices, serial replay on the dev laptop:**

| Phase | Session start | Now |
| --- | --- | --- |
| Reconcile phase (lookup + persist + pending sweeps) | 463 s | 45 s (620 CIs/s; in-memory core ≈ 1 s) |
| Outbox dispatch | 465 s | 62 s |

10k devices extrapolate to about 8 minutes serially, inside the 15-minute budget before worker concurrency.

**Decisions this session:** ADR-001…007. Collector endpoints that vary by cloud or deployment (Azure authority/ARM, NVD mirror, AWS partition suffix) are job options or the target, never literals. Unobserved members leave a redundancy group `unknown`, never `down`; an incident whose service drops to `unknown` is mitigated, not resolved.

## In progress

- Console sign-in (REQ-SEC-001 / REQ-SEC-009 / REQ-UI-003): OIDC Authorization Code + PKCE against Keycloak, bearer on every GraphQL call (background session).
- Collectors: 25 families built; none Done without recorded vendor fixtures (risk R-004). Not yet started: Device42-agent import (REQ-DISC-004), blade chassis / UCS / OneView (013), SMB/NFS share enumeration beyond ONTAP (016), GCP/OCI/Alibaba (010), Citrix ADC / A10 / HAProxy / NGINX (018), CRAC (026), SaaS inventories.
- REQ-INT-001/002/003: images and chart exist; a full `docker compose … apps.yml up` and a `helm install` on a cluster have not been run end to end yet.
- REQ-CORE-013: scale-1 replay (550k CIs) and the concurrent-worker measurement still to run.
- REQ-UI-007: force-layout toggle and the graph fps capture in tools/perf are outstanding.

## Blocked

- docs/SPEC.md still missing (risk R-001).
- Vendor lab fixtures (risk R-004).

## Next three

1. Finish console sign-in, then run the console against the live API with the synthetic tenant and walk every screen (dashboard → dependencies → CI detail → impact → services → discovery) in en and ar; capture screenshots for the review.
2. Bring the compose application overlay up end to end (`docker compose -f docker-compose.yml -f docker-compose.apps.yml up -d --build`) with a containerised Node enrolling against the containerised scheduler; fix what breaks.
3. Scale-1 replay for the 15-minute budget; then the remaining collector families and the Device42 agent import.

## Questions for Syed

1. Export the planning document to `docs/SPEC.md` so the tracker can be re-seeded and the contracts frozen against it.
2. Access to the vendor lab (or recorded `snmpwalk`, SSH, WinRM, REST transcripts) for Cisco, Arista, Dell iDRAC, HPE iLO, VMware, Nutanix, Pure, NetApp, Brocade/MDS, F5, APC: nothing can be fabricated.
3. Confirm ADR-006 (`@peculiar/x509`) and ADR-007 (Sigma.js + graphology, MIT) as accepted dependencies.
4. Confirm multi-tenancy is per business unit as drawn in onboarding.
