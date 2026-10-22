# OpenMap — build state

Read this first in every session (CLAUDE.md §2). If this file and the tracker disagree, the tracker wins.

## Last session · 2026-10-22 (marathon, checkpoint 2)

**What exists and runs**

- Monorepo per CLAUDE.md §5 (pnpm, Turborepo, strict TS, lefthook), Go workspace for `apps/node` and `apps/collectors` (Go 1.27).
- `packages/constants`, `packages/config`, `packages/i18n` (en + ar, parity-checked), `packages/contracts` (CI, collector, event, asset, impact, integration, organization; 18 JSON Schemas; GraphQL 0.1.0; twelve layers; CI short codes; headline metric per layer; `GLOBAL_IDENTITY_KEYS`), `packages/ui` (Obsidian Pro tokens and RTL components, 39 tests), `packages/db` (Prisma 6, 35 models, migrations 0001–0004 applied — 0004 adds the identity lookup indexes; ClickHouse DDL; Memgraph schema and triggers), `packages/graph` (Cypher repository on managed transactions with transient-error retry, `purgeTenant`; Memgraph default, Neo4j adapter; impact and time-travel verified live), `packages/testing`.
- `tools/tracker` (188 rows), `tools/guard`, `tools/synth-estate`, `tools/perf` (k6 impact-query budget test).
- `apps/api`: NestJS on Fastify, Mercurius; Keycloak JWKS auth; 26 unit + 12 integration tests; live smoke passed.
- `apps/console`: Next.js 15 shell with en/ar routing and RTL, dashboard, layers and CMDB routes (builds).
- `apps/scheduler`: planner and Node API (mTLS enrolment with CSR signing, heartbeat, atomic job pull, result intake, OpenBao credential resolution, results queue); tests pass. ADR-006 (`@peculiar/x509`) written, awaiting Syed.
- `apps/reconciler`: identity resolution, confidence merge, array-based persistence (one `INSERT … SELECT FROM unnest` per table), pending-relationship sweeps, outbox dispatcher (1000-row batches, bulk stream publish); `replay` (resets every store, prints phase split and CIs/s per run) and `bench` tools.
- `apps/bsm-engine`, `apps/assistant`, `apps/node` (Go) as at checkpoint 1.
- `apps/collectors` (Go), 16 families, all unit-tested against protocol-shaped fixtures served in-process (httptest, in-process DNS server, loopback listeners) or typed transcripts: `snmp`, `ssh_agentless`, `ipmi_redfish`, `vmware` (REST, legacy envelope fallback), `kubernetes`, `nutanix_ahv` (Prism v3), `kvm_libvirt` (virsh over SSH), `wmi` and `hyperv` (PowerShell over WinRM, NTLM/basic/Kerberos), `port_scan`, `dns` (AXFR), `certificate`, `vulnerability_feed` (NVD 2.0 compatible), `cloud_azure` (ARM), `storage` for Pure FlashArray and NetApp ONTAP, `fc_fabric` (Brocade FOS, Cisco MDS). Shared runners: `sshexec` (script and per-command exec), `winrmexec`, `restjson`.
- `deploy/compose`: full stack up and healthy locally; air-gap overlay.
- Design: 13 screens on the Obsidian Pro canvas: https://claude.ai/artifact/VcFmJuAaHCmrvgpPMmTzrf. AetherTwin cues in `docs/DESIGN-CUES.md`.

**Throughput (REQ-CORE-013 / REQ-PERF-003), scale-0.05 estate = 28,200 CIs, 66,332 relationships, 2,246 devices, serial replay on the dev laptop with the compose stack:**

| Phase | Before | Now |
| --- | --- | --- |
| Identity lookup | seq scan, ~290 ms per result | 17 s total (btree `= ANY` + GIN BitmapOr, chunks in parallel) |
| Persist | per-row Prisma writes | 14 s total (unnest inserts) |
| Pending relationship sweeps | 47 s | 13 s (10k batches) |
| Reconcile phase total | 463 s | 45 s (620 CIs/s) |
| Outbox dispatch | 465 s | 62 s |

The in-memory reconcile core is ~1 s for the whole estate (the earlier "121 s" figure was a label collision in the replay summary, now fixed). Extrapolated: 10k devices ≈ 8 minutes serially, inside the 15-minute budget before worker concurrency (`resultsConcurrency` 4) is counted.

**Decisions this session:** ADR-001…006. Collector endpoints that vary by cloud or deployment (Azure authority and ARM URLs, NVD mirror URL) are job options or the target itself, never literals (guard).

## In progress

- REQ-CORE-013 / REQ-PERF-003: scale-1 replay (550k CIs) and a concurrent-worker measurement are still to run; the dispatcher is now the longer phase (62 s): next candidates are ClickHouse async inserts and Memgraph UNWIND batches above 1000.
- REQ-DISC-001…027 collectors: 16 families built and unit-tested; none can reach Done without recorded vendor fixtures (risk R-004). Not yet started: Device42-agent import (004), blade chassis / UCS / OneView (013), NAS over SMB/NFS enumeration (016 beyond ONTAP shares), object storage (017), load balancers (018), NetFlow (019), DHCP (022), AD/LDAP (023), database discovery (024), PDU/UPS SNMP MIBs (026), AWS/GCP/OCI/Alibaba (010), Oracle VM (009), SaaS.
- REQ-DISC-028/031 Node and scheduler: built; end-to-end enrol → pull → result over real mTLS not yet exercised.
- REQ-UI-003… console: shell and three routes exist; remaining screens from the canvas are not built.
- REQ-INT-005/006/007 integrations: payloads and delivery engine exist; no adapter is wired to a real remote yet.

## Blocked

- docs/SPEC.md still missing (risk R-001).
- Vendor lab fixtures (risk R-004): no recorded walks or transcripts from real devices; collectors stay In progress.

## Next three

1. End-to-end discovery on the real stack: `scheduler pki:init`, start scheduler, enrol a Node, run `port_scan` and `certificate` against the compose stack itself (they need no credentials), watch CIs land through reconciler → Memgraph → API.
2. Console screens from the canvas: dependency map (Sigma.js in a worker, lane layout), CI detail, impact modeling wired to `runSimulation`, sites and connectivity, health and telemetry.
3. Dispatcher throughput and the scale-1 replay; then the remaining collector families (DHCP, LDAP, databases, load balancers, AWS).

## Questions for Syed

1. Export the planning document to `docs/SPEC.md` so the tracker can be re-seeded and the contracts frozen against it.
2. Access to the vendor lab (or recorded `snmpwalk`, SSH, WinRM, REST transcripts) for Cisco, Arista, Dell iDRAC, HPE iLO, VMware, Nutanix, Pure, NetApp, Brocade/MDS: nothing can be fabricated.
3. Confirm ADR-006 (`@peculiar/x509`, MIT) as the Node PKI library.
4. Confirm multi-tenancy is per business unit as drawn in onboarding.
