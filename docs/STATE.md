# OpenMap — build state

Read this first in every session (CLAUDE.md §2). If this file and the tracker disagree, the tracker wins.

## Last session · 2026-10-22 (marathon, checkpoint 6)

**What exists and runs**

- Monorepo per CLAUDE.md §5 (pnpm, Turborepo, strict TS, lefthook), Go workspace for `apps/node` and `apps/collectors` (Go 1.27).
- `packages/constants`, `packages/config`, `packages/i18n` (en + ar, parity-checked), `packages/contracts` (CI, collector, event, asset, impact, integration, organization; 18 JSON Schemas; GraphQL 0.1.0; twelve layers; CI short codes; `GLOBAL_IDENTITY_KEYS`), `packages/ui` (Obsidian Pro tokens and RTL components), `packages/db` (Prisma 6, 35 models, migrations 0001–0005 applied (0005 seeds the bootstrap organization and the `default` tenant the realm's seeded administrator belongs to); **native Postgres migration runner** on `pg` with Prisma-compatible bookkeeping, so images and air-gapped hosts migrate without the Prisma CLI; ClickHouse DDL; Memgraph schema and triggers; 80 tests), `packages/graph` (Cypher repository on managed transactions with transient-error retry, `purgeTenant`; impact and time-travel verified live), `packages/testing`.
- `tools/tracker` (188 rows), `tools/guard`, `tools/synth-estate`, `tools/perf` (k6 impact-query budget test).
- `apps/api`: NestJS on Fastify, Mercurius; Keycloak JWKS auth with the token issuer verified against `PUBLIC_KEYCLOAK_URL` (the origin the browser uses and `KC_HOSTNAME` writes into tokens) while the key set is fetched over the backchannel `KEYCLOAK_URL`; 26 unit + 12 integration tests; container image verified (`/healthz` ok, `/readyz` ready against the compose stack).
- `apps/console`: Next.js 15, en/ar, RTL. Screens: dashboard, layers, CMDB list, **dependency map** (Sigma.js + graphology WebGL, lane layout in a Web Worker, layer chips, time travel; ADR-007), **CI detail** (identity, attributes, relationships, impact, history diff, "Label this CI"), **impact modeling** (component explorer → conditions → `saveScenario`/`runSimulation` → affected services → `askAssistant`), **services** (propagated health, SLA budgets, incidents), **discovery** (Nodes, jobs, sweep, Run discovery), **sign-in** (OIDC Authorization Code + PKCE against the Keycloak realm: tokens in memory, refresh token mirrored to sessionStorage with silent renewal, RP-initiated logout, sign-in gate around the shell that starts in `restoring` on server and client alike, account menu with identity, tenant and realm roles, bearer on every GraphQL call; a rejected token ends the session with the API's wording and never restarts sign-in by itself, because a live SSO session would otherwise loop silently). 116 unit tests, 20 routes build, Playwright e2e in en and ar (sign-in, dashboard, every primary screen, CI detail) green against the live stack with screenshots in `docs/evidence/console/`.
- `apps/scheduler`: planner, Node API (mTLS enrolment with CSR signing, heartbeat, atomic job pull, result intake with evidence, OpenBao credential resolution, results queue), `pki:init`, **`node:register`** (one-time enrolment token) and **`job:submit`** CLIs.
- `apps/reconciler`: identity resolution, confidence merge, control-character sanitising, array-based persistence (`INSERT … SELECT FROM unnest` per table), pending-relationship sweeps, outbox dispatcher (1000-row batches, bulk stream publish, ClickHouse async inserts); `replay` and `bench` tools.
- `apps/bsm-engine`: **running service** (`main.ts`): CI health rules from observations (power, link, replicas, certificates, staleness), redundancy-group propagation to business services, `openmap.bsm.health.changed` events, incidents opened / updated / mitigated / resolved, delivery to ITSM, SIEM and on-call integrations with OpenBao credentials; verified live (fault injected in Memgraph → 3 incidents → cleared → mitigated).
- `apps/assistant`, `apps/node` (Go) as before; Node now passes `evidenceDir` so collectors store raw evidence by digest.
- `apps/collectors` (Go), **37 families** plus the host agent, all unit-tested against protocol-shaped fixtures served in-process or typed transcripts: `snmp` (MIB-II, IF, ENTITY, LLDP, Q-BRIDGE, **UPS-MIB, APC PowerNet, Raritan PDU**), `ssh_agentless`, `ipmi_redfish`, `vmware`, `kubernetes`, `nutanix_ahv`, `kvm_libvirt`, `wmi`, `hyperv`, `port_scan`, `dns` (AXFR), `certificate`, `vulnerability_feed` (NVD 2.0), `cloud_azure` (ARM), `cloud_aws` (signed Query/REST: STS, EC2, VPC, RDS, ELBv2, EKS), `storage_pure`, `storage_ontap`, `fc_fabric` (Brocade FOS, Cisco MDS), `dhcp` (Windows, ISC, Kea), `ldap` (AD/LDAP), `database` (PostgreSQL, MySQL, SQL Server, MongoDB, Redis; live-probed against the compose Postgres and Valkey), `object_storage` (S3-compatible, SigV4 known-answer tested), load balancers `load_balancer` (F5 iControl REST), `haproxy` (stats CSV), `citrix_adc` (NITRO), `nginx` (Plus API + stub_status), `a10_thunder` (aXAPI v3), `oracle_vm` (oVirt/OLVM/RHV), `netflow` (v5, v9, IPFIX, sFlow), `hpe_oneview`, `cisco_ucs` (UCS Manager XML API), `nas` (SMB over WinRM, Samba/NFS exports over SSH, NFS MOUNT protocol agentlessly), `cloud_gcp` (service-account JWT), `cloud_oci` (HTTP Signature), `cloud_alibaba` (RPC and ROA signatures), `saas` (Microsoft 365, Google Workspace, Salesforce, ServiceNow, Workday), CRAC units inside `snmp` (Liebert/Vertiv, ENTITY-SENSOR). **Host agent** `openmap-agent` (REQ-DISC-004): Linux/Windows/macOS inventory (DMI identity, OS, addresses, listeners with processes, software) reporting through the Node's mTLS agent gateway; the scheduler enrols agents with one-time tokens and files reports as runs of a standing `agent` job — verified live on compose. `docs/COLLECTORS.md` is generated from the binaries' `--manifest` by `apps/collectors/scripts/gen-docs.sh`. Shared runners: `sshexec`, `winrmexec`, `restjson`, `sigv4`.
- **End-to-end discovery verified on the dev stack**: `pki:init` → scheduler → `node:register` → Go Node enrolled over mTLS → `job:submit` port_scan and certificate → results through the queue → reconciler → Postgres and Memgraph (SECURED_BY edge visible), evidence stored on the Node.
- `deploy/`: `docker/node-service.Dockerfile` (api, scheduler, reconciler, bsm-engine; all build) and `docker/node.Dockerfile` (Node + 25 collectors, distroless, 190 MB); `compose/docker-compose.apps.yml` overlay with a migrations job; air-gap overlay and `airgap-bundle/` build/load scripts; `helm/openmap` chart (in-chart datastores, Keycloak, OpenBao or external, services, migrations hook, ingress; lints and renders). `deploy/README.md` documents all three profiles.
- **Security and audit**: role-gated console actions from the shared role table (REQ-SEC-001 Done), API tokens through the `openmap-automation` service account, realm TOTP and lockout policy, SSO brokering documented (REQ-SEC-009 in review); every mutation audited through the outbox into append-only `audit_logs` and ClickHouse, `auditLog` in GraphQL 0.2.0 (ADR-010), Settings screen (REQ-SEC-005 in review).
- **Performance**: Lighthouse 1.0 (performance, accessibility, best practices) on every screen, p95 interaction 32 ms, dependency map 60 fps on the production build (`docs/evidence/perf`); `tools/perf` holds the Lighthouse flow runner and guard enforces the budgets.
- **Deployment**: console image with run-time public settings, `helm install` green on kind (13 pods, migrations job, API ready, console 200 — `docs/evidence/helm`), chart fixes (migrations as a plain job with readiness waits, Memgraph volume ownership, Postgres schema init), `deploy/kind/cluster.yaml`.
- **Contracts frozen (REQ-CORE-001…006 Done)**: `pnpm contracts:check` (CI) compares `schema.graphql` with its committed base using graphql's breaking-change analysis — additions need a minor bump, breaking changes a major bump, the header version is pinned to `CONTRACT_VERSIONS.graphql`; the Go contract view in `apps/node` and `apps/collectors` is checked by reflection against the emitted JSON Schemas; the outbox dispatcher fan-out is unit-tested.
- **Audit log (REQ-SEC-005 Done)**: a real bug was found and fixed on the rebuilt image — the entry's follow-up UPDATE of the trace id hit the append-only trigger and aborted the transaction, so no mutation was audited while tracing was on; the event is now emitted first and the row written once. `openmap_audit_entries_total{action}` metric; tenant setting `auditRetentionDays` (seven years) drives the ClickHouse `audit_log` TTL (Postgres 0009, ClickHouse 0002); Settings screenshots with live entries in `docs/evidence/console`.
- **Services on bare metal (REQ-DISC-031, REQ-DISC-004 in review)**: both Go binaries read an environment file and host themselves as Windows services; `deploy/install/` has systemd units, a launchd daemon and sh/PowerShell installers that enrol once with the one-time token.
- **Offline bundle (REQ-INT-002)**: `build-bundle.sh` produced a 2.7 GB bundle with 17 images and checksums (`docs/evidence/airgap/bundle-build.md`); the realm import now takes the console's public URL from `CONSOLE_PUBLIC_URL`, so an air-gapped host at any hostname can sign in; the loader's checksum step works on BusyBox.
- **CI**: `verify` (guard, tracker, typecheck, unit, contracts check, i18n), `integration` (compose datastores), `e2e` (full compose stack, Playwright en+ar) and `kind` (helm install smoke) jobs — the last two await their first GitHub Actions run (REQ-QA-002/004 in review).
- Design: 13 screens on the Obsidian Pro canvas: https://claude.ai/artifact/VcFmJuAaHCmrvgpPMmTzrf.

**Throughput (REQ-CORE-013 / REQ-PERF-003), scale-0.05 estate = 28,200 CIs, 66,332 relationships, 2,246 devices, serial replay on the dev laptop:**

| Phase | Session start | Now |
| --- | --- | --- |
| Reconcile phase (lookup + persist + pending sweeps) | 463 s | 45 s (620 CIs/s; in-memory core ≈ 1 s) |
| Outbox dispatch | 465 s | 62 s |

10k devices extrapolate to about 8 minutes serially, inside the 15-minute budget before worker concurrency.

**Decisions this session:** ADR-001…007. Collector endpoints that vary by cloud or deployment (Azure authority/ARM, NVD mirror, AWS partition suffix) are job options or the target, never literals. Unobserved members leave a redundancy group `unknown`, never `down`; an incident whose service drops to `unknown` is mitigated, not resolved.

## In progress

- REQ-INT-002 / REQ-SEC-003: air-gap verification — the bundle is being loaded inside a Docker-in-Docker host whose new outbound connections are dropped by iptables (DNS and registry provably unreachable); smoke and the e2e suite run against it from the host on ports 13000/14000/18080. Result recorded in `docs/evidence/airgap/load-airgap.md` when complete.
- REQ-DISC-031 / REQ-DISC-004 (in review): installers exist; a packaged release (signed binaries, tarball with `bin/`, `collectors/`, `install/`) is still to produce.
- REQ-SEC-009: SAML brokering and MFA are realm policy still to capture in `realm-openmap.json`; API tokens done.
- Collectors: every planned family exists; none is Done without recorded vendor transcripts (risk R-004).
- REQ-CORE-013: scale-1 replay (550k CIs) and the concurrent-worker measurement still to run.
- REQ-UI-007: force-layout toggle and the graph fps capture in tools/perf are outstanding.

## Blocked

- docs/SPEC.md still missing (risk R-001).
- Vendor lab fixtures (risk R-004).

## Next three

1. Finish the air-gap proof (REQ-INT-002 → Done, REQ-SEC-003) and rebuild the bundle with the parametrised realm; then push so the new CI jobs run (REQ-QA-002/004 → Done).
2. Release packaging for the Node and the agent (REQ-DISC-031/004 → Done): tarballs per OS with `bin/`, `collectors/`, `install/`, checksums; the SaaS layer screen (REQ-CMDB-011).
3. Scale-1 replay for the 15-minute budget; then the remaining collector families and the Device42 agent import.

**Dev-stack notes (also in project memory):** the Keycloak realm import runs with IGNORE_EXISTING, so realm-file edits reach an existing realm only through the admin REST API (user profile first, then user attributes); the local `admin` user's `tenant` attribute points at the synthetic tenant so the console shows the estate, while a fresh install keeps `default` (migration 0005). The browser console error buffer in the desktop app accumulates across navigations; the Next dev-server log is the clean signal.

## Questions for Syed

1. Export the planning document to `docs/SPEC.md` so the tracker can be re-seeded and the contracts frozen against it.
2. Access to the vendor lab (or recorded `snmpwalk`, SSH, WinRM, REST transcripts) for Cisco, Arista, Dell iDRAC, HPE iLO, VMware, Nutanix, Pure, NetApp, Brocade/MDS, F5, APC: nothing can be fabricated.
3. Confirm ADR-006 (`@peculiar/x509`) and ADR-007 (Sigma.js + graphology, MIT) as accepted dependencies.
4. Confirm multi-tenancy is per business unit as drawn in onboarding.
