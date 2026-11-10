# OpenMap — build state

Read this first in every session (CLAUDE.md §2). If this file and the tracker disagree, the tracker wins.

## Last session · 2026-11-10 (checkpoint 47: REQ-SEC-011 encryption in transit for all six stores; seven P1 rows merged)

Syed: "finish SEC-011, closing PERF-002 and PERF-004, and the 11 P1 rows".

### Encryption in transit is done for every store (ADR-068 "As built")

| Store | Protocol | A renewed certificate is taken |
| --- | --- | --- |
| PostgreSQL | `hostssl` only | SIGHUP from `pgtde-agent` |
| ClickHouse | HTTPS 8443, secure native 9440 | file reload |
| Valkey | `rediss://`, plain port closed | `CONFIG SET` to a new file, no restart |
| Meilisearch | HTTPS | restart (seconds) |
| Memgraph | `bolt+s://` | restart (minutes); a one-year certificate |
| OpenBao | HTTPS | compose: SIGHUP from `openbao-certs`; Helm: the chart renews its own pair |

- **Client trust.** `loadEnv()` adds the bundle at `SERVICE_CA_PATH` to Node's default CA set, so fetch, ioredis and
  neo4j-driver verify against it with no client options (T-585).
- **OpenBao's first certificate.** On compose, `openbao-keys` makes it with `bao server -dev -dev-tls`. On Helm,
  `genCA`/`genSignedCert` make it into `<release>-openbao-tls`.
- **Tests.** T-586 reaches each store over TLS and is refused in plain text. Valkey loaded a renewed certificate live;
  Meilisearch restarted on its own.
- **Moves.**
  - The dev stack moved, following deploy/README.md, "Moving a running install to TLS". pg_tde's provider record now
    reads `https://openbao:8200` with the CA path.
  - Helm was verified on kind: a fresh install had every store pod ready on internal-CA certificates.
- **Evidence:** `docs/evidence/sec-tls-stores.md`. Commits e7bc16b, e4fd4af, d0a814f.

### Found and fixed

- **Helm could not have installed since OpenBao went to server mode.**
  - OpenBao's readiness probe deadlocked the init job.
  - `register()` never registered a secret id, because `secret-id/lookup` succeeds for unknown ids. The refused logins
    then tripped OpenBao's AppRole lockout (`sys/locked-users`).
  - The Percona volume was root-owned.
  - Meilisearch's probe could never pass: it answers only clients that send SNI.
- **Docker Desktop's `::1` port forward drops connections.**
  - Through `localhost`, 3 of 40 new Prisma connections failed after 30 s each. Through `127.0.0.1`, 40 of 40 took
    1.2 s.
  - Host-side addresses now use `127.0.0.1`, and every store certificate names it. Prisma resolves `localhost` itself,
    so `NODE_OPTIONS` does not help.
- **The TLS move on the dev stack.**
  - Superset and Keycloak still held connections, so the stop killed PostgreSQL, and the offline pg_tde change refused
    the unclean directory.
  - The way out was OpenBao on its plain configuration for a minute, recovery, then a clean stop. The README now stops
    every client first.
- **The CA bundle.** An existing bundle had no final newline, so the bootstrap CA was glued onto its last line;
  `openbao-keys` now puts it on a line of its own.
- **Scheduler integration tests** deleted their organisation before the discovery node that references its site.

### Seven P1 rows merged from parallel work

| Row | What | Contract | Evidence |
| --- | --- | --- | --- |
| REQ-IPAM-007 | Network circuits on inter-site links: register, path diversity, redundancy lost (ADR-069) | GraphQL 1.46.0 (allocated 1.41.0), migration 0046 | `docs/evidence/ipam-circuits.md` |
| REQ-SEC-012 | Compliance posture per framework: 27 controls, 14 checks, five frameworks (ADR-070) | GraphQL 1.42.0, migration 0047 | `docs/evidence/sec-compliance-posture.md` |
| REQ-PERF-005 | Platform health screen, SLO rules, budgets enforced in CI by guard (ADR-071) | GraphQL 1.43.0 | `docs/evidence/perf-platform-health.md` |
| REQ-INT-011 | Ansible, Salt, Puppet and Chef dynamic inventory, read by the real tools (ADR-072) | REST 1.2.0 | `docs/evidence/int-config-management.md` |
| REQ-INT-012 | Monitoring ingest from six vendors; Alertmanager end to end (ADR-073) | GraphQL 1.45.0, migration 0050 | `docs/evidence/int-monitoring-ingest.md` |
| REQ-INT-016 | Identity federation: AD/LDAP and OIDC (Entra ID, Okta) through Keycloak (ADR-074) | GraphQL 1.47.0 (allocated 1.46.0), migration 0051 | `docs/evidence/int-identity-federation.md` |
| REQ-INT-017 | Backup and DR awareness from Veeam, Commvault and Rubrik (ADR-075) | GraphQL 1.48.0 (allocated 1.47.0), CI and collector 0.14.0, migration 0052, Memgraph 0005 | `docs/evidence/int-backup-awareness.md`; stays Blocked on vendor access |

The rows merged out of allocation order, so each later merge took the next GraphQL minor version; CONTRACTS.md records
the allocated and released numbers.

### Verified on the TLS stack after the merges

| Check | Result |
| --- | --- |
| Workspace typecheck, lint and unit tests (turbo) | 56 of 56 tasks |
| Integration suites, host on `127.0.0.1` | vault 3, graph 5, reconciler 32, bsm-engine 7, scheduler 4, assistant 12, api 140 (4 skipped), appliance 2 |
| Assistant evaluation | 41 of 41 (`docs/evidence/assistant-eval.json`); golden set 12 of 12 |
| Playwright e2e, full suite | en 61 of 61, ar 61 of 61; RTL screenshots for the new screens in `docs/evidence/console` |

The integration and e2e runs found faults, all fixed:
- **Retention.** Backups were kept and listed by name, not age, so a named set could prune the newest.
- **Console.** It lacked the CA mount that `loadEnv` now needs.
- **Assistant.** The 1.5B model chose `:Host` for VMs once the merged contract changed its prompt; a worked example
  fixed that.
- **Tests.** Several merged specs had substring locators. One counted the Next.js route announcer as an error. The
  scheduler tests had a cleanup-order bug.
- **Dev host.** `E2E_RESOLVE_LOCALHOST_TO=127.0.0.1` gets around Docker Desktop's hanging `::1` forward for the e2e
  browser.


### Open

- **REQ-PERF-002 and REQ-PERF-004** close on a CI run: "k6 threshold enforced in CI" and "sweep timed in CI nightly".
  The GitHub repository became private this session. The public API now answers 404 and this machine has no `gh`, so CI
  results cannot be read from here. Main is pushed (d0a814f).
- **REQ-CORE-020**: the scale-1 replay measurement with concurrent workers. It resets tenant `570b1953`, so it runs
  last.
- **REQ-INT-014**: Blocked (vendor APIs; HPE and IBM have no open API). **REQ-INT-017**: Blocked on vendor access, as
  decided on 2026-11-07.
- **REQ-INT-018** stays In review until one image build boots on a KVM host.
- **Old plaintext volumes** `openmap_postgres-data` and `openmap_clickhouse-data` are still kept as a fallback.
- **graphify.** The session's 62 changed docs were extracted and merged into the graph (21,000 nodes). Two things were
  left for a full rebuild:
  - The 28 new screenshots.
  - The changed TypeScript files: this graphify build parsed none of 391, and merging would have replaced their
    existing nodes with nothing, so their nodes are still the pre-session ones.
- **The kind cluster** is stopped again. The old `openmap` release in it predates OpenBao's server mode.

### Next three

1. Read the CI run of d0a814f once it can be seen, and close REQ-PERF-002 and REQ-PERF-004 on it.
2. REQ-CORE-020: the scale-1 replay (`replay --reset --dispatchers N` on `.local/estate-s1b`, then `replay-history`
   and the assistant evaluation), recorded in `docs/evidence/reconciler-scale.md`.
3. The P2 rows: REQ-INT-013 (Terraform provider, Pulumi) and REQ-INT-015 (finance and procurement).

### Questions for Syed

- **CI visibility.** The repository is private now. Make it public again, run `gh auth login` on this machine, or
  read the Actions page yourself and tell me the result of d0a814f.
- **May the old plaintext volumes be deleted?** The stack has run on the encrypted ones since checkpoint 46.

## Previous session · 2026-11-10 (checkpoint 46: REQ-SEC-011 encryption at rest complete, ADR-067 steps 3–6)

### Encryption at rest is done end to end on compose and Helm

| Step | What | Evidence |
| --- | --- | --- |
| 3 | PostgreSQL on Percona 17.11.1 with pg_tde. Every table is `tde_heap`, the WAL is encrypted, and the key is in OpenBao through an OpenBao Agent. The dev stack moved twice through backup sets, the second time for the collation fix. | `docs/evidence/sec-pgtde-migration.md` (433e444) |
| 4 | Transit field encryption: vendor contacts, asset custodians and their audits, and sensitive custom fields. CI 0.12.0, GraphQL 1.40.0, migration 0045. Backfill with `reconciler encrypt-fields`. | `docs/evidence/sec-field-encryption.md` |
| 5 | Encrypted backup sets: a per-set Transit data key, AES-256-CTR plus HMAC, and `BackupSet.encrypted`. | `docs/evidence/sec-backup-encryption.md` |
| 6 | ClickHouse on an encrypted disk, its key from OpenBao through the `clickhouse-keys` agent. | `docs/evidence/sec-clickhouse-encryption.md` |

### Budgets on the fully encrypted stack

| Budget | Result | Limit |
| --- | --- | --- |
| Impact p95 | 76 ms | 1 s |
| Telemetry p95 (138k CIs) | 60 ms | 100 ms |
| Discovery sweep (+38 % from the ClickHouse encryption) | 8.36 min per 10k devices | 15 |
| Encrypted backup | 67 s | — |

### Found and fixed along the way

- **The Percona image initialised the database with collation `C`.** Name ordering changed, and three e2e specs broke.
  The database is now created with `--locale=en_US.UTF-8` (`POSTGRES_LOCALE`, Helm `postgres.locale`).
- **The reconciler had no AppRole mount.**
- **The perf frame rate was capped by the display.** vsync is now off for the perf spec: 540 fps against 60.
- **The assistant example button was ambiguous** once past conversations were listed; the examples are now a
  labelled group.
- **The restore brought no planner statistics;** it now runs `ANALYZE`.

### Open

- **REQ-SEC-011 stays In progress** for encryption in transit (ADR-068).
  - The internal services CA (OpenBao PKI) is in place, and **PostgreSQL TLS is done**: required, verified, renewed by
    `pgtde-agent`. See `docs/evidence/sec-tls-postgres.md`.
  - **ClickHouse TLS is done:** HTTPS 8443 and secure native 9440 only, clients through `clickhouseOptions`, Superset
    verified. See `docs/evidence/sec-tls-clickhouse.md`, commit 7745d71.
  - **Next: Valkey, Memgraph, Meilisearch, then OpenBao's own listener.** They differ from PostgreSQL and ClickHouse
    in one way: none of them reloads a renewed certificate on its own.
    - Valkey reloads on `CONFIG SET tls-cert-file`, so it needs a small reloader beside it that has `valkey-cli`.
    - Memgraph and Meilisearch need a restart. Memgraph's restart reloads a 750k-node snapshot (minutes), so it should
      use a certificate from a longer-lived role (for example one year), plus an expiry alert, rather than 30 days.
    - OpenBao's listener needs a bootstrap certificate from `openbao-keys` (openssl, once), added to `service-ca`.
    - Clients to change: ioredis and BullMQ (`rediss://` plus `tls.ca`), neo4j-driver (`bolt+s://` and a trusted CA),
      the Meilisearch fetch (`https` plus the CA through an undici agent), and every OpenBao client (`https` plus the
      CA).
- **Host-side dev note:** Docker Desktop's port forwarding on this machine drops bursts of more than about 25 new
  connections (TLS or not).
  - Host-side integration suites: run them with `--no-file-parallelism`.
  - The host `POSTGRES_URL` in `.env` is quoted, verified against `.local/services-ca.crt`, and uses a pool of 5.
  - Docker Desktop was not restarted, because other projects' containers run on it.
- **Old plaintext volumes** `openmap_postgres-data` and `openmap_clickhouse-data` are kept on the dev machine as
  the way back. Remove them once the stack has run on the new ones; they hold the data unencrypted.
- The kind cluster `openmap-control-plane` is stopped.

**Tests added:** T-574 … T-580.

## Previous session · 2026-11-10 (checkpoint 45: REQ-SEC-011 steps 1–2 committed; impact walk breadth first)

### What happened

- **The tracker queue ran.** Excel released the workbook. These closures are now written:
  - REQ-DCIM-008, REQ-IPAM-004, REQ-IPAM-005, REQ-INT-009 and REQ-INT-019 are Done.
  - ADR-062…067 are recorded.
  - The contract versions are recorded: CI and collector 0.11.0, event 0.12.0, GraphQL 1.39.0.
  - The session row is added and the report regenerated. `tracker verify` is ok.
  - The "queued" blocks in checkpoints 39–44 below are history; none of them is still waiting.
- **Impact walk on Memgraph is breadth first** (3feaa6b, REQ-PERF-002):
  - The twin asks for both directions at six hops. The path walk hit 26.9 M paths and timed out.
  - `impactQueryMemgraph` leaves the target unlabelled. A labelled `(x:Ci)` makes Memgraph run a point-to-point
    search to all 750k CIs, which is why the 2026-11-08 BFS attempt was slow.
  - Results match the old walk. The worst PDU went from 421 ms to 220 ms.
  - Memgraph 3.4.0 crashes on `collect({..., path: [n IN nodes(p) | n.id]})`, so that form is avoided.
  - See `docs/evidence/impact-query.md`.
- **SaaS product names:** `SPE_E3` now shows "Microsoft 365 E3" (T-574).
- **e2e locator fix:** the perf and walkthrough specs no longer take the CMDB import link for the first CI.
- **Full e2e:** 107 passed, 1 skipped. The three failures were re-run after their fixes and passed.
- **References relationship type** (CI and collector 0.11.0, ADR-064 consequences): firewall rule → object links
  are no longer impact edges.
- **REQ-SEC-011 step 2 done** (`docs/evidence/sec-pgtde-verification.md`):
  - Percona 17.11.1 with pg_tde: tables and WAL are encrypted. The stock control shows the plaintext canary.
  - Token revocation and key rotation were verified, with no Postgres restart needed.
  - pgbench: writes −6.8 % TPS, bulk load +52 %, no read cost measurable.
  - Fixed: the `PGTDE_AGENT_UID` ownership bug.

### Next

**Next (step 3)**: migrate the compose and Helm Postgres to Percona 17.11.1 with `tde_heap`.

- Move the data through the REQ-INT-019 backup and restore (`pg_restore --no-table-access-method`, so the default
  `tde_heap` applies).
- Wire the agent sidecar beside the main Postgres.
- Acceptance: `impact-budget`, the k6 suite and a scale replay on the TDE server.

Then step 4 (Transit field encryption), step 5 (encrypted backups), step 6 (ClickHouse encrypted disk), and the
in-transit TLS work.

**Dev notes**:

- Stop the kind cluster (`docker stop openmap-control-plane`) before e2e or perf runs.
- `up -d <app>` re-runs openbao-init.

## Previous session · 2026-11-10 (checkpoint 44: REQ-SEC-011 step 1 of 6, production OpenBao)

Syed chose pg_tde + OpenBao Transit field encryption (question 18). ADR-067 sets six steps; **step 1 is done**:
OpenBao 2.7.2 in server mode (Raft, static-key auto-unseal, init job, KV v2 + Transit, `openmap-services` and
`openmap-backup` policies and AppRoles), the services on AppRole through the new `@openmap/vault` token provider
(re-login at 75 % of the lease or after a 403), Raft snapshots in every backup set, Prometheus scraping OpenBao, Helm
StatefulSet + init hook with chart-generated seal key and AppRole ids, deploy/README operations. Evidence
`docs/evidence/sec-openbao-production.md`; tests T-572, T-573 (+ T-568 extended).

**Next (step 2)**: verify pg_tde 2.x on a pinned Percona Distribution for PostgreSQL 17 image with the OpenBao KV v2
key provider; its token file is kept fresh by an OpenBao Agent sidecar (pg-tde AppRole) — confirm pg_tde re-reads
the file; enable WAL encryption; measure the replay and k6 budgets against stock PostgreSQL. REQ-SEC-011 stays In
progress until step 6 and the in-transit TLS work are done.

**Dev note**: host-side tests that touch OpenBao export `OPENBAO_TOKEN` from `.local/openbao-root-token`.

## Previous session · 2026-11-10 (checkpoint 43: REQ-INT-019 backup and restore Done)

**REQ-INT-019 Done** (ADR-066, GraphQL 1.39.0, T-567..T-571, commit d751d18).

- **Backup**: `openmap/backup` (FROM postgres:17, curl) runs `deploy/backup/openmap-backup.sh create|verify|restore|list|prune`:
  `pg_dump -Fc` of the whole database, ClickHouse native `BACKUP DATABASE … TO File('<set>/clickhouse')` on the shared
  `backups` volume (`clickhouse/backups.xml`), manifest `openmap-backup/1` (sizes, sha256s, migration, CI count),
  `BACKUP_KEEP` retention; `restore --postgres-url … --clickhouse-db …` for drills. Compose service `backup` (profile
  `backup`); air-gap bundle ships the image and the clickhouse config dir (it was missing before).
- **Projections**: `reconciler reproject [--tenant] [--keep]` rebuilds Memgraph and Meilisearch from Postgres.
- **API / console**: `backups` (administrators) from manifests under `BACKUP_DIR` (read-only mount);
  `openmap_backup_last_complete_timestamp_seconds` at scrape time; Settings → Backups card.
- **Measured on the dev stack**: backup 56 s (698 MB archive of 9.4 GB Postgres, 1.39 GB ClickHouse), verify 18 s,
  reproject 28k CIs + 74k relationships in 68 s from the host. One real set `openmap-20261110T081131Z` is on the volume.

**Tracker (queued, Excel holds the workbook)**:

```
pnpm tracker set REQ-INT-019 --status Done --owner Claude --tests T-567,T-568,T-569,T-570,T-571 --evidence "commit d751d18; ADR-066; GraphQL 1.39.0; docs/evidence/int-backup-restore.md; docs/evidence/console/settings-backups-{en,ar}.png"
```

**Next three**: REQ-INT-017 backup/DR awareness (Veeam, Commvault, Rubrik `backed_by`), REQ-INT-011 configuration
management inventory, REQ-INT-016 identity federation.

## Previous session · 2026-11-10 (checkpoint 42: REQ-INT-009 webhooks and notifications Done)

**REQ-INT-009 Done** (ADR-065, event 0.12.0, GraphQL 1.38.0, T-562..T-566, commit f33d6e2).

- **Engine** (`apps/bsm-engine/src/integrations/notify.ts`, `smtp.ts`): every event on the stream goes to the tenant's
  enabled notification integrations subscribed to its type: signed webhook (`x-openmap-signature: v1=<HMAC-SHA256 of
  "<timestamp>.<body>">`), Slack Block Kit, Teams Adaptive Card, PagerDuty Events v2 (not for incidents; the incident
  adapter keeps those), email through the engine's own SMTP client. Minimum severity, 30 messages a minute per
  integration, airgap / `FEATURE_OUTBOUND_INTEGRATIONS` / tenant switches; every attempt an IntegrationDelivery; sent in
  the background so health propagation never waits.
- **API**: `sendTestNotification` (operators) → outbox test event + audit; the engine sends it to that integration only.
- **Console**: notification settings in the integration form, "Send a test notification" with delivery polling.
- **Compose**: `FEATURE_OUTBOUND_INTEGRATIONS` passed through, default false, so the live e2e shows the refusal; real
  delivery is proven by T-564 (stack Postgres and OpenBao, HTTP receiver verifying the signature, SMTP server).

**Tracker (queued, Excel holds the workbook)**:

```
pnpm tracker set REQ-INT-009 --status Done --owner Claude --tests T-562,T-563,T-564,T-565,T-566 --evidence "commit f33d6e2; ADR-065; event 0.12.0; GraphQL 1.38.0; docs/evidence/int-notifications.md; docs/evidence/console/integrations-notify-{en,ar}.png"
```

**Waiting on Syed**: REQ-SEC-011 (question 18, Postgres at rest); REQ-UI-021/022/023 (question 0, native charts or
Superset). **Next three**: REQ-INT-019 backup and restore, REQ-INT-017 backup/DR awareness, REQ-INT-011 configuration
management inventory.

## Previous session · 2026-11-10 (checkpoint 41: REQ-IPAM-005 firewall rules and policy objects Done)

**REQ-IPAM-005 Done** (ADR-064, CI and collector 0.10.0, GraphQL 1.37.0, T-558..T-561, commit 2662750).

- **Collector**: the agentless SSH collector runs `sudo -n nft -j list ruleset` (a sudoers entry for exactly that
  command; without it the host reports no firewall). Rules keep chain order, matches (addresses, `@set`, `!`, services
  `proto/port`, ICMP types, interfaces, other conditions), verdicts, jump/goto and NAT targets, counters, log flags;
  base chain policies become last rules; named sets become `firewall_object` CIs that rules `depends_on`. Recorded
  capture `fixtures/vendor/ssh_agentless/debian-debian-12-nftables` (real collector against a Debian 12 container);
  the five earlier captures are marked as predating the `nft` section.
- **Contract**: new CI type `firewall_object` (identity deviceRef + objectId), migration 0043, Memgraph 0003;
  `packages/contracts/src/firewall.ts`: matching (IPv4/IPv6), evaluation, analysis (shadowed, unused, permissive rules;
  unused objects). Constants `FIREWALL`.
- **API**: `firewallDevices`, `firewallPolicy`, `firewallCheck`; metric `openmap_firewall_reads_total{query}`.
- **Console**: IPAM **Firewall** tab (device choice, traffic check across firewalls or one, seven totals, chains, rules
  with findings and a findings filter, policy objects); 96 i18n keys; specs isolated with `<bdi>` for Arabic.
- **Synth estate**: edge firewalls carry zone and service groups (one retired), rules naming them, a forgotten
  `temp-any-allow` on some, a shadowed narrow copy on some, a cleanup deny; drawn from a per-device stream so the
  rest of the estate is unchanged. The dev tenant got `snmp.ndjson` replayed without reset (`.local/estate-005-fwonly`):
  77 rules, 72 objects, and the REQ-IPAM-004 learned MACs on switch ports.
- **Tests**: Go sshlinux (fixtures 6 captures, firewall 3), contracts 99, API firewall integration 3, console 377,
  e2e IPAM 3 of 3 (en, ar). Evidence `docs/evidence/ipam-firewall.md`, `docs/evidence/console/ipam-firewall-{en,ar}.png`.

**Tracker (queued, Excel still holds the workbook)**: add to the queue below

```
pnpm tracker set REQ-IPAM-005 --status Done --owner Claude --tests T-558,T-559,T-560,T-561 --evidence "commit 2662750; ADR-064; CI 0.10.0; GraphQL 1.37.0; docs/evidence/ipam-firewall.md; docs/evidence/console/ipam-firewall-{en,ar}.png"
```

**Next three**: REQ-SEC-011 encryption at rest and in transit, REQ-UI-021 standard reports and scheduled exports,
REQ-UI-022 DOQL. Knowledge graph refresh for DCIM-008, IPAM-004 and IPAM-005 pending.

## Previous session · 2026-11-10 (checkpoint 40: REQ-IPAM-004 switch ports, MAC tables and port history Done)

**REQ-IPAM-004 Done** (ADR-063, GraphQL 1.36.0, T-554..T-557, commit 6bc0611).

- **Collector**: the SNMP collector walks Q-BRIDGE `dot1qTpFdbPort/Status`, else BRIDGE-MIB `dot1dTpFdbPort/Status`,
  learned entries only, mapped through `dot1dBasePortIfIndex`; interfaces carry `learnedMacs` (canonical, at most 64,
  MAC order) and `learnedMacCount`, emitted only when the table was walked. Job option `skipMacTable`.
- **Read model** (`packages/contracts/src/switch-ports.ts`, `apps/api/src/ipam/switch-ports.service.ts`): port state,
  speed, VLAN, neighbour (`connected_to` either way, or `cabled_to`), learned MACs resolved to owner CI and ARP IP,
  unused after `SWITCH_PORTS.unusedDays` (30) not up; port history from ClickHouse `ci_history` (90 days plus the
  baseline, newest first); `macLookup` in any spelling. Metric `openmap_switch_port_reads_total{query}`.
- **Console**: IPAM **Switch ports** tab (switch search, MAC lookup, six totals, port table, port history), 57 i18n keys.
- **Synth estate**: hosts' and VMs' MACs learned on their top-of-rack ports. The dev tenants predate this, so the live
  screen shows no learned MACs until the estate is replayed.
- **Tests**: Go FDB 4, contracts 90, API switch-ports integration 4, console 372 (switch ports 5), e2e IPAM 3 of 3 (en,
  ar). Evidence `docs/evidence/ipam-switch-ports.md`, `docs/evidence/console/ipam-switch-ports-{en,ar}.png`.

**Tracker (queued).** The workbook is still open in Excel (EBUSY), so both closures are queued; the tracker wins over
this file until they run:

```
pnpm tracker set REQ-DCIM-008 --status Done --owner Claude --tests T-550,T-551,T-552,T-553 --evidence "commit 632291d; ADR-062; GraphQL 1.35.0; docs/evidence/dcim-cable-verification.md; docs/evidence/console/dcim-cabling-verify-{en,ar}.png"
pnpm tracker set REQ-IPAM-004 --status Done --owner Claude --tests T-554,T-555,T-556,T-557 --evidence "commit 6bc0611; ADR-063; GraphQL 1.36.0; docs/evidence/ipam-switch-ports.md; docs/evidence/console/ipam-switch-ports-{en,ar}.png"
pnpm tracker session --summary "REQ-DCIM-008 cable verification; REQ-IPAM-004 switch ports"
pnpm tracker report
```

**Next three**: REQ-IPAM-005 firewall rules and policy objects, REQ-SEC-011 encryption at rest and in transit,
REQ-UI-021 standard reports and scheduled exports. Knowledge graph refresh for DCIM-008 and IPAM-004 docs pending.

**Lessons.** (1) The MAC results list carried `role="status"`, which hides list semantics from assistive tech; a live
region belongs on `aria-live`. (2) Prettier reflows the generated JSON schemas; regenerate them with
`tsx src/emit-json-schema.ts` instead of formatting them.

## Previous session · 2026-11-10 (checkpoint 39: REQ-DCIM-008 cable verification and labels Done)

**REQ-DCIM-008 Done** (ADR-062, GraphQL 1.35.0, T-550..T-553, commit 632291d).

- **Verdicts** (`packages/contracts/src/cabling-verify.ts`): each recorded cable (ADR-056) is traced from both ends
  through the patch panels to the device ports it joins and judged against observed adjacencies: verified, mismatch
  (names what was seen instead), unobserved, unverifiable (unpatched panel side, loop, end not a port). Observed links
  are indexed by device; links no recorded path explains are undocumented, counted in full, the first
  `CABLING.undocumentedLimit` (200) listed with the label a recorded cable would get.
- **Observations** (`apps/api/src/cabling/cabling-verify.service.ts`): one SQL join over `connected_to` (interface to
  interface, or interface to device with `remotePortId`) and `cabled_to` (host NIC to switch port), each interface's
  device from its `contains` parent, cable and circuit end relationships excluded. 1.6–1.7 s for 88,854 adjacencies.
  Queries `cablingVerification`, `cablingLabelsCsv`; metric `openmap_cabling_verifications_total`; span `cabling.verify`.
- **Console**: verification card on the Cabling tab (five totals, verdicts mismatch-first, undocumented links with a
  Record action that fills the cable form with the label and both device ports, labels CSV download). 27 i18n keys.
- **Tests**: contracts 85, API cabling integration 3, console DCIM 25, e2e DCIM 3 of 3 (en, ar). Evidence
  `docs/evidence/dcim-cable-verification.md`, `docs/evidence/console/dcim-cabling-verify-{en,ar}.png`.

**Tracker (queued).** The workbook was open in Excel when this checkpoint was written, so the closure is queued:
`pnpm tracker set REQ-DCIM-008 --status Done --tests T-550,T-551,T-552,T-553 --evidence "commit 632291d; ..."`, then
`pnpm tracker session` and `pnpm tracker report`. The tracker wins over this file until that runs.

**Lessons.** (1) The console image's build fetches Google Fonts (`next/font/google`); one build failed on a bad
response and passed on retry. Vendoring the five typefaces with `next/font/local` removes the build's last outbound
call (follow-up). (2) The first verification read copied each device's link list per link (quadratic on core switches)
and sorted 89,000 labels with `localeCompare`; indexing in place and ordering by a plain key took it from seconds to
well under two.

## Previous session · 2026-11-09 (checkpoint 38: REQ-DCIM-007 capacity planning Done)

**REQ-DCIM-007 Done** (ADR-061, GraphQL 1.34.0, T-546..T-549, commit cabfabd).

- **Query `roomCapacity(roomId)`** (`apps/api/src/dcim/capacity.service.ts`): per rack the free units and contiguous
  free blocks, design power (`designKw`, else PDU ratings) against the latest `dcim.power.watts` per PDU from
  `metrics_latest`, live against total ports of its network devices (`portCount` or interface count; `ifOperStatus`
  up); per room the totals, rated cooling of the room's units against the drawn load, and a least-squares trend of the
  daily PDU draw over 30 days with days to the 70 % and 90 % lines (`CAPACITY`). Nothing is estimated: no sample →
  unknown. Metric `openmap_dcim_capacity_reads_total`, span `dcim.capacity.room`.
- **Arithmetic in the contract** (`packages/contracts/src/capacity.ts`): `freeBlocks`, `largestFreeBlock`,
  `capacityState`, `worstCapacityState`, `linearTrend`, `daysUntil`, `fitsInRack`, shared by API and console.
- **Console**: Capacity tab on the DCIM screen (`CapacityView.tsx`): four figures with states, totals, trend card,
  "what fits" form (height, draw, ports) packing into each rack's free blocks within power and port headroom, racks
  worst first with the fit count. 42 i18n keys per locale.
- **Tests**: contracts 82 (4 new), API integration (seeded room on the compose stack, trend 22/38 days), console 3,
  e2e DCIM step: 3 of 3 (setup, en, ar); Lighthouse: dcim 0.97 / 1 / 1. Evidence `docs/evidence/dcim-capacity.md`,
  `docs/evidence/console/dcim-capacity-{en,ar}.png`.

**Lessons.** (1) `Card` in `@openmap/ui` does not forward `data-*` attributes: put test ids on an inner element.
(2) A whole number of days from floating-point kW ((5.6 − 3.4) / 0.1) needs an epsilon before `Math.ceil`.

## Previous session · 2026-11-09 (checkpoint 37: REQ-CORE-021 relationship attributes on re-observation Done)

**REQ-CORE-021 Done** (event 0.11.0, T-544 unit in `reconcile.test.ts`, T-545 `relationships.integration.test.ts`, commit eb2f89d).

- **Decisions from Syed (2026-11-09).** REQ-BSM-007: "tier-1 site" is business criticality 1, a new site attribute;
  `tier` stays the facility's Uptime tier (question 06 closed). Vendor access (lab captures, warranty and EoX
  credentials, SaaS developer tenants, code signing) is deferred to a later phase: the 29 Blocked rows stay parked.
- **Reconciler.** `reconcile()` compares a re-observed relationship's merged attributes (new keys over stored, keys
  the collector no longer reports kept, as for CIs) by checksum against the stored edge: changed → `relationshipsUpdated`
  with the observing run as source and an `openmap.relationship.updated` event carrying `changedKeys`; unchanged →
  `relationshipsSeen` (observedAt refresh only, no event). `persist()` writes the attributes and provenance; the
  dispatcher treats the update as an upsert for Memgraph (edges there carry id, tenant and validity, not attributes)
  and appends a `relationship_history` row in ClickHouse through the existing relationship payload path.
- **Contract.** Event 0.11.0 adds `openmap.relationship.updated` (CONTRACTS.md row; ADR-059 consequence closed).
- **Tests.** Reconciler unit 40 (new: changed outlet updates, unchanged stays a no-op), integration against the compose
  Postgres (create → move outlet → re-observe unchanged), contracts 78, guard and `contracts:check` green.

## Previous session · 2026-11-09 (checkpoint 36: REQ-DCIM-006 environmental monitoring Done)

**REQ-DCIM-006 Done** (ADR-060, GraphQL 1.33.0, T-538..T-543, commit 0dc055b).

- **Readings.** Temperature, humidity and cooling capacity are samples on the CI they describe, with a `position` label:
  rack inlet and outlet (or a probe on the rack's PDU), cooling unit supply and return, room humidity. The SNMP
  collector emits them from Liebert units and ENTITY-SENSOR probes, reading a probe's position from its name.
- **States.** ASHRAE A1 (`ENVIRONMENT`): 18–27 °C recommended, 15–32 °C allowable; 8–80 % RH allowable, 60 % RH the
  recommended upper limit. A rise of more than 20 °C across a rack is starved airflow. Readings older than 3 h are
  shown but not judged.
- **API.** `roomEnvironment(roomId, hours)`.
- **BSM engine.** It opens and resolves incidents (source `environment`) for racks outside the allowable range. On the
  dev tenant it opened two real ones: RYD-DH01-B-08 at 33.7 °C and DMM-COLO-DH01-A-09 at 33.0 °C.
- **Dev tenant data.** `synth environment-history` replayed into it (`.local/estate-005-env`, 13,566 samples). The
  power and environment histories end at their generation time, so the screens judge them only for 3 h afterwards.
  Regenerate with a later `--now` and replay to refresh.
- **Screen.** The DCIM switch is now Racks / Floor plan / Power / Environment / Cabling; its pills wrap at the default
  width, which is cosmetic.

**Next:** REQ-DCIM-007 (capacity planning: space, power, cooling, ports), then DCIM-008 (cable labels and
verification), REQ-CORE-021 (reconciler relationship attributes).

## Previous session · 2026-11-09 (checkpoint 35: REQ-DCIM-005 power monitoring, thresholds and billing Done)

**REQ-DCIM-005 Done** (ADR-059, GraphQL 1.32.0, migration 0042, T-532..T-537, commit 1b30cc6).

- **Collector.** The SNMP collector emits `dcim.power.watts` (PDU total) and `dcim.outlet.watts` (each metered outlet,
  on its `power_feed` CI) as samples. No contract version moved.
- **Contracts.** `energyOf` (trapezoid between samples only, with the hours covered), `powerState`,
  `powerSettingsSchema`, `pduRatedWatts`.
- **API.** `powerSettings` and `updatePowerSettings` (administrators); `powerMonitor(roomId, hours)` returns PDU series,
  state, peak, energy and cost, the outlets with their devices, and billing by device with its cost centre.
- **BSM engine.** It opens and resolves incidents (source `power`) for PDUs over the critical line. Readings older than
  3 h are not judged. On the dev tenant nothing is over the line: the estate's PDUs draw at most 4.2 kW against 32 A
  ratings.
- **Screen.** The Power view has a monitoring panel: window, totals, PDU draw sparklines, billing by device, and the
  lines and tariff.
- **Dev tenant data.** `synth power-history` replayed into it (`.local/estate-005-power`, then
  `.local/estate-005-power-cords` with `--structure-only`): 4,433 outlets, 4,417 devices powered by their outlet, and
  252,681 outlet plus 11,514 PDU readings over 14 days. Replay with an absolute `--dir`, because a relative one
  resolves under apps/reconciler.
- **Found: the reconciler never updates a relationship's attributes on re-observation.** Re-emitting a cord with an
  outlet number changed nothing. Device-to-outlet is therefore its own relationship. Updating relationship attributes
  is a reconciler follow-up worth a tracker row.

**Next:** REQ-DCIM-006 (environmental: temperature, humidity, airflow), DCIM-007 (capacity planning), DCIM-008 (cable
labels and verification).

## Previous session · 2026-11-09 (checkpoint 34: REQ-DCIM-004 power chain and redundancy Done)

**REQ-DCIM-004 Done** (ADR-058, GraphQL 1.31.0, T-528..T-531, commit a1453a4). The DCIM switch is now Racks / Floor plan
/ Power / Cabling.

- **Assessment.** `packages/contracts/src/power.ts` holds `circuitRatedWatts` (√3·V·A for three phases) and
  `assessPower`. Its findings are single-corded devices, devices on one feed, PDU/circuit/UPS pairs whose survivor
  would overload, UPS runtime under `POWER.minUpsRuntimeMinutes`, and PDUs over their outlets. A pair with an
  unmeasured member is not judged.
- **API.** `PowerService` provides:
  - `powerChain(roomId)`: the room's UPS, circuits and PDUs, the findings and a summary;
  - `pduConnections(pduId)`;
  - `connectPower` and `disconnectPower` (operators): the outlet must be free and within the PDU's count, and the cord
    takes the PDU's feed.

  Writes are audited and counted (`openmap_power_connections_total`).

- **Real findings in the dev estate.** For example, DMM-COLO-DH01-A-03 PDU-A has 25 cords on 24 outlets. The generator
  plugs more devices into some PDUs than they have outlets; that is genuine estate data, left as found.
- The first console build of this round failed in `next/font/google` (the fonts are fetched at build time); the retry
  built. That is a sovereignty and air-gap gap worth a requirement: self-host the fonts. See Questions.

**Questions for Syed** (in addition to checkpoints 31 to 33):

1. The console fetches its Google fonts at build time (`apps/console/src/lib/fonts.ts`, `next/font/google`), so an
   air-gapped image build needs network. Should the fonts be vendored with `next/font/local` (a new SEC/CORE
   requirement)?

**Next:** REQ-DCIM-005 (power monitoring, thresholds, billing by outlet), then DCIM-006..008.

## Previous session · 2026-11-09 (checkpoint 33: REQ-DCIM-003 room floor plan Done)

**REQ-DCIM-003 Done** (ADR-057, GraphQL 1.30.0, T-524..T-527, commit 760060d).

- **Floor plan view.** The DCIM screen switch is now Racks / Floor plan / Cabling.
  - The plan is a pure function of the `racks` query (`apps/console/src/lib/floor-plan.ts`). It shows each room's rows
    in row-position order, with their aisle and rack slots up to `rackCapacity`.
  - Heat is measured power against the feeds' rating, against `designKw`, or units in use. A rack with no reading says
    "no reading".
- **Moving a rack.** `placeRack(rackId, rowId, position)` (operators) moves a rack to a free slot of a row in its own
  room. The rack's `row` and `position` attributes and its `located_in` change through the outbox; the twin reads the
  same attributes.
- The racks query now reads row attributes, and its fields are shared with the mutation (`RACK_FIELDS`).
- The cabling e2e waits `ACTION_MS` for a searched endpoint option. Search was slower than `expect`'s 5-second default
  under the Memgraph memory pressure below.

**Environment finding.** Memgraph holds 745,678 vertices and 1,991,235 edges (all tenants, including the scale-1
one): 15.8 GiB resident, 19 GiB tracked, against the VM's 23.47 GiB. The twin e2e's focus step (an impact graph for
one host) fails with "Memory limit exceeded" (an 896 MiB allocation). It is not caused by the cabling or floor plan
work; those code paths do not touch Memgraph queries. Options:

- drop the scale-1 tenant from Memgraph when it is not being measured;
- give the WSL VM more memory;
- set Memgraph's `--memory-limit` below the VM's, so a query fails fast instead of starving the rest of the stack.

**Next:** REQ-DCIM-004 (power: PDUs, outlets, feeds, circuits, UPS, redundancy), then DCIM-005..008.

## Previous session · 2026-11-09 (checkpoint 32: REQ-DCIM-001 structured cabling Done; REQ-QA-003 Blocked)

**REQ-DCIM-001 Done** (ADR-056; CI and collector 0.9.0, GraphQL 1.29.0; T-520..T-523; commit d3e9357).

- **Records:** patch panels, cables (patch leads, trunks, cross-connects) and carrier circuits (a new `circuit` CI type)
  are CIs written through the outbox.
  - A panel is `located_in` its rack, with its rack unit.
  - A cable or circuit is `connected_to` each end, with the end, the port and the panel side on the relationship.
  - Panel positions are numbers on the panel, not CIs, so no new `*Ref` target is needed.
- **Rules:** a port takes one cable or circuit. `traceCable` (contracts) walks cable → panel → cable to the far end and
  reports incomplete paths and loops.
- **API:** `cabling`, `cableTrace`, plus the operator mutations to mount and remove panels, connect and disconnect
  cables, and record and remove circuits. Writes are audited, counted (`openmap_cabling_changes_total`) and traced.
- **Screen:** the DCIM screen has a Racks / Cabling switch. The e2e mounts two panels, patches a switch through both
  to a server, traces the path, records a circuit, then takes it all down. It also sweeps leftovers of an
  interrupted run (`E2E-` prefix). Evidence: `docs/evidence/console/cabling-{en,ar}.png`.
- **Migrations:**
  - 0040: `circuit` added to `CiType`.
  - Memgraph `0002_circuit`: the label index. The schema test now reads every Memgraph file.
  - 0041: `link_probe` added to `CollectorFamily`. REQ-BSM-007 had left it out of the enum, so the db schema test was
    red.
- `useDebounced` moved to `apps/console/src/lib/use-debounced.ts`, shared by Impact and Cabling.
- Power circuits stay with REQ-DCIM-004; cable labels and their LLDP verification with REQ-DCIM-008.

**REQ-QA-003 Blocked.** It needs real vendor equipment or recordings from it, and R-004 forbids fabricated fixtures.
See Questions.

**Environment.**

- After the Windows restart the kind cluster `openmap-control-plane` came back and ran at about 200% CPU. Sign-ins
  timed out and connections to the published ports were reset, so it was stopped again (`docker start
openmap-control-plane` brings it back).
- Free space on E: held at 42.6 GB through two image builds. The VHDX reuses the space freed inside it.

**Questions for Syed:**

1. Compact the Docker VHDX (about 874 GB on E:) or move it. See checkpoint 31.
2. OpenBao runs in compose dev mode, which keeps secrets in memory, so a restart wipes the credential sets. Should the
   single-node profile get a file storage backend (a new requirement)?
3. REQ-QA-003: lab access to, or recorded SNMP/CLI/API transcripts from, the vendor devices listed in R-004.

**Next:** REQ-DCIM-003 (room layout and floor plans), then REQ-DCIM-004..008, SEC-011, UI-021..023 and INT-009.

## Previous session · 2026-11-08/09 (checkpoint 31: REQ-IPAM-003 two-way DNS sync Done; Docker recovered after E: filled)

**REQ-IPAM-003 Done** (ADR-055, GraphQL 1.28.0, migration 0039; T-512..T-519).

- **Reconciler:** a full zone transfer retires the records it no longer holds (T-512).
- **Collector:** the DNS collector pushes RFC 2136 updates signed with TSIG (T-513).
- **Contracts:** the change contracts (T-514).
- **Scheduler:** a sync planner and loop, settled from the transfer (T-515, T-516).
- **API** (T-517).
- **Screen:** the IPAM DNS tab's DNS sync panel (T-518).
- **e2e (T-519)**, en and ar, against the lab BIND 9 (`dns-lab`, profile `lab`, zone `lab.openmap.test`, key
  `openmap-sync`, secret `DNS_LAB_TSIG_SECRET` in the gitignored `.env`). A record is added from the screen, applied
  by BIND, confirmed by the transfer and reconciled into the CMDB; it is then deleted, applied, and retired.

  Evidence: `docs/evidence/console/dns-sync-{en,ar}.png`.

  e2e fixes:
  - the bearer token comes from the Keycloak token exchange;
  - form fields are found by role, because Playwright's `getByLabel` exact reads the option text inside a wrapping
    label;
  - `page.setDefaultTimeout(30 s)`.

**Docker incident.** `E:\DockerDesktopWSL\disk\docker_data.vhdx` grew to about 850 GB and filled E:. The engine's disk
hit I/O errors mid-build, and Docker Desktop then stopped at start-up on the dockerInference socket. Syed restarted
Windows, which cleared it.

- `.local/bundle`, the stale air-gap bundle, was deleted; it is regenerable.
- The build cache was pruned: its metadata pointed at missing snapshots.
- `docker system df` now shows about 185 GB in use (images 101.7 GB, volumes 75.8 GB, containers 8.1 GB). The VHDX
  stays at about 874 GB and E: has about 43 GB free, and the VHDX grows with every build.
- After the restart, the first `up -d` left the old reconciler container Dead; `docker rm -f`, then `up -d` again,
  fixed it.

**Questions for Syed:**

1. Compact the Docker VHDX, or move it to a disk with room. This needs Docker Desktop quit and an elevated
   `Optimize-VHD -Path E:\DockerDesktopWSL\disk\docker_data.vhdx -Mode Full`, or diskpart `compact vdisk`.
   `docker image prune` and `docker container prune` would free about 42 GB more inside the disk; volumes are not
   touched without your say.
2. OpenBao in compose runs `server -dev`, which keeps secrets in memory, so a restart wipes every credential set
   (the lab TSIG secret came back only because the e2e saves it). Should the single-node profile use a file storage
   backend instead (a new requirement)?

**Next:** REQ-QA-003 (P0, vendor lab fixtures; parked on real devices per R-004), then REQ-DCIM-001 (cabling, patch
panels, circuits, cross-connects) and REQ-DCIM-003 (room layout and floor plans).

## Previous session · 2026-11-08 (checkpoint 30: REQ-CORE-020 outbox claims and dispatch throughput, REQ-PERF-004 sweep within budget, REQ-UI-026 Sites screen, REQ-UI-027 telemetry fleet, REQ-AI-002 classification, REQ-AI-003 anomalies, REQ-AI-005 cloud advice, REQ-AI-006 assistant anomalies)

Syed: "keep coding and dont wait for my promoting". REQ-CORE-020 and REQ-PERF-004 are In review (ADR-050, migrations
0035 and 0036). Evidence is in `docs/evidence/reconciler-scale.md` and `docs/evidence/discovery-sweep.json`.

**1. Which target was slow.** The dispatch report now times each target per batch (`targetMs`, `bookkeepingMs`).

- **Memgraph.** Every statement over about 1.5 KB stalled for about 45 ms, whatever its row count. This happens from
  the host and, less often, inside the compose network. Client `TCP_NODELAY` does not fix it. A batch sent about 25
  statements.
- **ClickHouse.** Each of six async inserts waited for a flush, one after another.
- **Postgres.** The claim walked the primary key past every delivered row: 1.6 s per claim with 2.6 million rows.

**2. Fixes.**

- **Graph batch.** `GraphRepository.applyBatch` writes one batch in one pipelined transaction (T-488). Relationship
  retirements find their edge from the source CI.
- **ClickHouse.** Inserts of `RECONCILER.clickhouseSyncInsertRows` (500) rows or more are synchronous, and a batch's
  inserts run side by side.
- **Leased claims (migration 0035).** `UPDATE … FOR UPDATE SKIP LOCKED` sets `claimedBy` and `claimedUntil`, with a
  5-minute lease. Partial indexes over the undelivered rows serve it (migration 0036). Rows close grouped by what is
  left to deliver.
- **Deferred relationships.** A relationship whose endpoint is not in the graph stays pending (`deferred`,
  `openmap_outbox_deferred_total`).
- **Dispatch loops.** `RECONCILER_DISPATCHERS` sets the loop count, default 1. Two loops deliver each row exactly once
  (T-489) but were slower on seed 45 (35 s against 27 s), because relationships overtook their CIs.
- **Replay.**
  - It takes `--dispatchers N` and claims only its own tenant.
  - It retries ticks that deliver nothing (`RECONCILER.replayStallTicks`) instead of stopping at the first transient
    failure.
  - It exits non-zero on undelivered rows.
- **Schema retry.** `ensureSchema` retries Memgraph's transient "unique access to the storage" error.

**3. Results.**

- **Seed 45, scale 0.05:** dispatch went from 67.8 s to 27.3 s.
- **Sweep, seed 44, scale 0.25:** **8.43 min per 10,000 devices**, against a 15-minute budget (was 17.77). Dispatch went
  from 899 s to 178 s. All 508,341 events were delivered, and two transient ClickHouse failures were retried. Postgres
  and Memgraph both hold 138,242 CIs and 369,761 relationships. ClickHouse holds 508,341 events, all distinct.

**4. REQ-UI-026 Sites and connectivity — Done** (ADR-025 amendment, GraphQL 1.22.0, REST 1.1.0, T-490 to T-493).

- **Site facility cards:**
  - kind, tier, power capacity and design PUE from the site CI;
  - measured PUE from `dcim.site.pue`;
  - racks counted in the CMDB facility tree;
  - open alerts: open findings plus unresolved incidents located in the site.
- **Links:** carrier, throughput against committed bandwidth with a usage bar, and the redundancy state
  (`linkRedundancy` in the BSM engine).
- **Synthetic estate:** site CIs carry `powerCapacityKw` and `designPue`, and a link's throughput is bandwidth ×
  utilisation. The draw is kept, so the RNG stream is unchanged.
- **Dev tenant:** updated in place by replaying only the site results (`.local/estate-042-sites`) and fresh link samples
  (`.local/estate-042-links`). No reset, so the ids and health history are kept.
- **Images:** `openmap/api:dev` and `openmap/console:dev` were rebuilt.
- **Follow-up:** readiness finding details are English text from the BSM engine, shown as-is in Arabic.

**5. REQ-UI-027 Health and telemetry fleet — Done** (ADR-051, GraphQL 1.23.0, T-494 to T-497).

- **Route:** `/telemetry`, served by `telemetryFleet`.
- **Snapshot:** one per tenant, joining ClickHouse latest samples, Postgres CIs and Memgraph health. It refreshes in the
  background every 30 s. At build time it sorts rows for every key and every category, joins the search text into one
  string, and counts rows by category and health.
- **Console:** 50-row pages in a TanStack Virtual table, with health and category pills, a text filter and sortable
  headers.
- **k6** (`pnpm --filter @openmap/perf telemetry-budget [--tenant]`, guard reads `results/telemetry-fleet.json`):
  - p95 62 ms on the 138k-CI tenant `4ca6233c`;
  - 130 ms on the 551k-CI tenant. REQ-PERF-006 (P2) tracks that gap.
- **Perf tooling:** `tools/perf/src/keycloak.ts` now holds the load-test token helper that both budgets use.

**6. REQ-AI-002 classification of unknown CIs — Done** (ADR-052, GraphQL 1.24.0, migration 0037, T-498 to T-501).

- **Classifier:** fingerprints in constants (`DEVICE_FINGERPRINTS`); `classifyCi` in the assistant package scores
  sysDescr, banner, vendor and ports. It got 290 of 290 of the estates' unknown CIs right, against the generator's
  `deviceKind`, which it never reads.
- **Suggestions:** stored in `classification_suggestions`. Accepting writes the CI's user label through `labelCi`;
  dismissing is remembered until the evidence changes. The acceptance rate shows on a panel on the Layers screen.
- **Images:** `openmap/api:dev` and `openmap/console:dev` were rebuilt.

**7. REQ-AI-003 anomaly rules — Done** (ADR-053, GraphQL 1.25.0, migration 0038, T-502 to T-506).

- **Rules:** `ip_conflict`, `unmanaged_device_in_datacenter` and `flapping_service`, pure functions in the assistant
  package.
- **Findings:** kept in `anomaly_findings`. A sweep runs every `ANOMALY_INTERVAL_MS`, and `detectAnomalies` runs one on
  demand.
- **Explanations:** `explainAnomaly` uses the local model in the prose locales and the catalogue template elsewhere,
  which means Arabic on the CPU profile.
- **Screen:** `/anomalies`.
- **Ground truth:** the generator plants one IP conflict and one data-centre camera (estate summary), plus one flapping
  service (health history).
- **Dev tenant:** got these through a replay without `--reset` and a reload of the health history (`replay-history
--reset`). The earlier replay without stripped samples duplicated this tenant's metric rows in ClickHouse `metrics`;
  `metrics_latest` is unaffected.
- **Result:** precision and recall 1.0.

**8. REQ-AI-005 cloud recommendations — Done** (ADR-054, GraphQL 1.26.0, T-507 to T-510).

- **Model:** `recommendCloud` in the assistant package, with thresholds in `CLOUD_ADVICE`: release stopped resources
  that are still billed, decommission idle compute, downsize under-used compute (saves half its cost), upsize hot
  compute.
- **Load:** a 14-day window, else the latest sample.
- **Query and screen:** `cloudAdvice`, shown in a panel on the Utilisation screen.
- **Scale-1 result:** 39 recommendations, an estimated 83,663 USD a month.

**9. REQ-AI-006 assistant over the graph — Done** (ADR-028 amendment, GraphQL 1.27.0, assistant contract 0.3.0,
T-511).

- **Coverage:** natural language to Cypher (REQ-AI-001) and impact explanation (the `impact` intent) were in place; the
  assistant now also answers about the anomaly findings through the `anomalies` intent and skill, in English and
  Arabic.
- **Evaluation:** 41 of 41 on the scale-1 tenant (`docs/evidence/assistant-eval.json`).

**10. Remaining for Done.**

- **REQ-CORE-020:** the scale-1 measurement its acceptance names. It needs tenant `570b1953` reset, then
  `replay-history` and the assistant evaluation rerun. Alternatively, Syed may accept the scale-0.25 sweep.
- **REQ-PERF-004:** the nightly CI run, which needs a remote.

## Previous session · 2026-11-08 (checkpoint 29: assistant at 100k scale, REQ-BSM-004 impact accuracy, REQ-BSM-005 runbooks, REQ-BSM-007 sites, REQ-CORE-019 REST/SDK, REQ-PERF-002 impact under 1 s)

Syed: "run the assistant evaluation on the new estate", then "keep coding and dont wait for my promoting".

**1. Assistant evaluation on the scale-1 estate** (`2a56a0a`, `353f569`). The evaluation picks the tenant with the most
business services, which is now the scale-1 tenant `570b1953` (300 services, 40,000 hosts).

- **Failure 1:** every measurement question failed. The host scope went to ClickHouse as one bound array, and ClickHouse
  caps a query-string field at 128 KiB (about 3,000 UUIDs). `metrics.latest` and `metrics.series` now read in batches
  of `ASSISTANT.clickhouseIdBatch` (2,000), 4 at a time. The partials combine exactly; the evidence carries the scope
  size, not the ids (T-462).
- **Failure 2:** a period with no health history read "0%, no downtime". It now reads "not measured", with no 0%
  figure, and its target is neither met nor missed (T-463).
- **Result:** 38/38 with Qwen2.5-Coder-1.5B (`docs/evidence/assistant-eval.json`). Host CPU averages 48.64% across
  40,000 hosts; the PDU ranking and the Arabic answers are correct.
- **Earlier fixes, recorded:** T-460 (an unfiltered measurement reads only CIs of its type) and T-461 (`back` counts
  from the newest period) are on REQ-AI-007 and REQ-AI-008 (`67e0c9f`).
- The API image was rebuilt; the console's assistant answers "44.51% across 2,000 hosts" on the dev tenant.

**2. Synthetic outages spread over the whole month** (`215ed8d`, T-464).

- **The bug:** each outage started up to window/(count+1) after the previous one, so outages fell in the first half of
  each 30-day window. The ten days before `--now` never had one, and every service read 100% this month.
- **The fix:** each outage now falls anywhere in its own slot.
- Both tenants' health history was regenerated and reloaded.

**3. REQ-BSM-004 impact prediction accuracy** (ADR-047, migration 0032, GraphQL 1.19.0, Impact contract 1.1.0).

- **What is compared:** every resolved or closed incident that names a root cause.
  - It is compared with the person's latest saved simulation of exactly that root cause, run before the incident
    opened.
  - Failing that, with a replay: a scenario of origin `incident`, `failed`, redundancy honoured, run over the current
    graph. Replays are kept out of the saved list.
  - Accuracy is the Jaccard similarity of predicted (down or degraded) and actual services (`compareImpact`).
- **Misses:** each missed service becomes a suggestion, root cause `part_of_service` missed service. That is the edge
  the impact traversal follows into services.
  - Accepting creates the relationship as a person's edit.
  - Dismissing keeps the row, so the miss is not suggested again.
- **When:**
  - The API sweeps every `IMPACT_VALIDATION_INTERVAL_MS` (60 s), up to 50 incidents per tenant, taking one incident of
    each tenant in turn.
  - `validateImpactPredictions` runs a sweep on demand, and `validateImpactPrediction(incidentId)` re-validates one
    incident.
  - There is one current validation per incident.
- **Observability:** metrics `openmap_impact_validations_total{outcome}` and `openmap_impact_prediction_accuracy`;
  span `impact.validate`.
- **Console:** the Impact screen's Prediction accuracy panel shows the mean, counts, the latest validations (root cause,
  services hit, missed, over-predicted, accuracy) and the suggestions with Accept and Dismiss, in en and ar.
- **Dev data:** `replay-history` now names a root cause for every replayed incident, picked deterministically among
  the components, database clusters, VMs, hosts and hypervisors the service's applications depend on. Reset also drops
  the replay scenarios and open suggestions.
- **Measured pace:** one validation takes 0.9 s on the dev tenant and about 7 s on the scale-1 tenant, so its 3,651
  incidents drain over about 7 hours of sweeps.
- **Accuracy on the dev stack measures over-prediction:** a shared component predicts every service its applications
  serve (one dev incident predicted all 15, accuracy 0.07).

**4. REQ-BSM-005 runbooks** (ADR-048, migration 0033, GraphQL 1.20.0, Impact contract 1.2.0).

- **Catalogue:** each tenant has a runbook catalogue (`runbooks`, code unique) storing `runbookSchema`. A step's
  automation must name a SOAR or automation integration.
- **Attachment:** scenarios and incidents attach a runbook by reference (`runbookId`), replacing the never-filled JSON
  column. An incident without one is offered the runbook of the saved scenario of its root cause.
- **Running a step** (`runRunbookStep`) records a `runbook_step_runs` row.
  - A manual step is recorded `done`.
  - An automated step passes the outbound gate, takes its credential from OpenBao and is delivered through the BSM
    engine's `deliver()`: an AWX job-template launch (`api/v2/job_templates/{action}/launch/`, the incident as
    `openmap_` extra vars), an XSOAR incident that runs the playbook, or a POST for other vendors. It is recorded
    `triggered` or `failed`.
- **Estimates:** a runbook's estimate is the sum of its step minutes. A simulation with a runbook takes that estimate as
  its outage length and leads its recommendations with the runbook. An incident shows the estimate and the minutes
  still to go.
- **Console:** the Impact screen has the runbook catalogue (list and editor) and a runbook picker on each saved
  scenario. The incident card has a Runbook section: attach, run or mark each step, and the history of runs.
- **Observability:** metric `openmap_runbook_steps_total{outcome}`; span `runbook.step`.

**5. REQ-BSM-007 sites and connectivity for HA / DR readiness** (ADR-025, migration 0034, CI and collector 0.8.0,
GraphQL 1.21.0).

- **New attributes:**
  - Site CIs carry `drRole` (primary, dr, none) and `criticality` (1 = most critical); `tier` stays the facility's
    Uptime tier.
  - Link CIs carry `replication`, `probeTarget` and `slaLatencyMs`.
  - Setup writes them, and the synthetic estate generates them: RYD is primary, JED is DR, and the RYD–JED fibre
    carries replication.
- **The `link_probe` collector (Go)** makes TCP-connect probes: reachable, median latency, loss. It emits samples on the
  link CI by id and no CI.
- **The scheduler** plans a probe job per Node every `LINK_PROBE_INTERVAL_MS` (60 s). A link goes to a Node at its
  A-end site, else to any capable Node. A busy Node is skipped, and old probe jobs are pruned.
- **The BSM engine** derives link health from the latest probes, never from attributes.
  - It evaluates `diverse_paths`, `dr_reachable` and `replication_healthy` every minute.
  - A breach opens a `readiness_findings` row and an incident (source `readiness`, root cause the site or link, no
    services). A cleared breach resolves the incident.
- **Sites screen (`/sites`)** shows the rules with their findings and incidents, the sites with their DR role and
  healthy paths, and the links with live figures. It is in en and ar.
- **Dev stack:**
  - The estate's probe targets are the far WAN gateways, which the dev stack cannot reach, so the links read down and
    the rules breach.
  - The healthy path is proven by T-480 (samples in ClickHouse through each transition) and T-477 (real local
    listeners).
  - The dev tenant was regenerated and replayed without a reset: 19 site and link CIs updated, ids kept.

**6. REQ-CORE-019 REST API, OpenAPI and SDK** (ADR-049, REST contract 1.0.0).

- **One route table** (`packages/contracts/src/rest.ts`, `REST_ROUTES`) drives three things:
  - the API's REST v1 controllers (`apps/api/src/rest`, thin over the GraphQL services);
  - the OpenAPI 3.1 document (`GET /api/v1/openapi.json`, public; also written to
    `packages/contracts/openapi/openapi.json` at build);
  - the TypeScript SDK `@openmap/sdk`: typed methods, `allCis()` page iteration and `graphql()`.
- **Routes:** CIs (list, get, patch attributes, relationships, impact), relationships (create, retire), search,
  incidents, connectivity.
- **Auth:** the Keycloak bearer token, with the tenant from the token. Writes need the operator role.
- **Observability:** `openmap_rest_requests_total` and `openmap_rest_request_duration_seconds`; a `rest.<route>` span.
- **Console:** Settings has an API card with the addresses and every route from the live document, in en and ar.
- **Other languages:** SDKs are generated from the OpenAPI document.

**7. REQ-PERF-002 impact query under 1 s** (In review; `docs/evidence/impact-query.md`).

- **Before:** a PDU's 31,355-node impact took 6.5 s on the scale-1 tenant; p95 under 8 VUs was 2.0 s.
- **Causes and fixes:**
  - Memgraph planned the closure ∪ service-hop `UNION ALL` badly, at 2.7–3.2 s against 16–560 ms for the halves: the
    halves now run as two queries. A `*BFS` rewrite was rejected (7–12 s).
  - Every closure node was hydrated from Postgres: now only the services are, and `ImpactNode.ci` resolves through the
    batch loader when selected.
  - The impact projection is lean, `{ id, tenantId, type, tier }`. `tenantId` must stay: without it the service hop
    plans at 2.7 s.
  - Service prediction is lighter (health of members only, members indexed, models cached 30 s).
  - graphql-jit.
- **After:** p95 874–975 ms with the worst cases in the mix; a single worst case takes 0.47–0.78 s.
- **Tooling:** `tools/perf impact-budget` does the run (tenant, measured widest roots, a Keycloak load-test user, k6).
  The CI `perf` job is written but has not run (no remote). The workflow's `concurrency` line was invalid YAML and is
  fixed.

**Follow-up found:** `api.integration.test.ts` "matches operating systems … lifecycle" is flaky. `instances(first: 1)`
on two hosts has no stable order; it passed twice on rerun.

**Tests:**

- REQ-PERF-002: T-487 (k6 impact budget through `impact-budget`).
- REQ-CORE-019: T-483 (SDK), T-484 (integration through the SDK: public document, analyst reads, operator writes,
  403/400/404, counters), T-485 (console), T-486 (e2e, en and ar).
- REQ-BSM-007: T-477 (Go probe), T-478 (planner), T-479 (rules), T-480 (integration), T-481 (console), T-482 (e2e,
  en and ar).
- REQ-BSM-005: T-470 (estimates), T-471 (integration, in-test AWX receiver: gate refused, launch with bearer token and
  extra vars, `done`, remaining minutes 0), T-472 (vendor requests), T-473 (recommendations), T-474 and T-475
  (console, en and ar), T-476 (e2e, en and ar).
- New: T-460…T-463 (assistant), T-464 (health generator), T-465 (contract `compareImpact`), T-466 (integration:
  miss → suggestion → accept → edge in Memgraph → next incident predicted), T-467 (validation rules), T-468 (console
  panel, en and ar), T-469 (e2e, en and ar).
- Passing: api unit 43, console unit 321, contracts 58, bsm-engine 46, synth-estate 32, reconciler 38, db 86.
- Guard, `contracts:check` and `i18n:check` are green.

**Follow-ups:**

- The per-validation cost on the 550k-CI tenant (about 7 s) is the simulation's graph and facts reads, the same path
  as an interactive what-if run at that scale; measure it against the 1 s impact budget (REQ-PERF).
- The reconciler image was not rebuilt: `replay-history` runs from the host.

## Previous session · 2026-11-07 (checkpoint 28: scale-1 replay inside the budget, REQ-CORE-013 Done; checkpoint 27 follow-ups)

Syed approved the six follow-ups of checkpoint 27 ("yes take them up in the reconciler session").

**1. A SaaS application's `tenantRef` resolves within its vendor** (`83826ea`, ADR-045 amendment).

- A ref counts only targets in the issuer scope it shares with them (`refScopeKeys` in
  `packages/contracts/src/identity.ts`): the scope keys of the target type's scoped global keys that the referring type
  also declares.
- Today that is `saas_application.tenantRef` → `saas_tenant`, by `vendor`. The rule is derived from
  `GLOBAL_IDENTITY_SCOPES`, so `ci-identity.json` and the contract versions are unchanged.
- The Go harness applies the same rule (T-454).
- Dev replay: refs pending 18 → 16; the ServiceNow and Workday applications of `horizonbank` name their own tenants.

**2. Scale-1 replay — REQ-CORE-013 Done** (`docs/evidence/reconciler-scale.md`, `.json`, ADR-046).

- **Estate:** `synth generate --seed 43 --scale 1` gives it its own tenant (`570b1953-…`); the dev tenant's 0.05 estate is
  untouched. It holds 550,747 CIs, 1,321,979 relationships and 45,030 devices.
- **Result:** with one serial worker the replay takes 3,175 s end to end, 11.75 min per 10,000 devices, inside the
  15-minute budget:
  - reconcile phase 1,056 s, of which lookup 424 s and pending pass 247 s;
  - dispatch 2,119 s, 2,025,274 events, 0 failures.
- **Identities:** 550,746 created (every distinct estate identity), 1 updated (vendor Microsoft), 0 conflicts, 0
  duplicates, 0 pending relationships. Memgraph and ClickHouse each hold 550,746 CIs.
- **Before the fixes:** the first complete run took 4,671 s (17.3 min per 10,000 devices).
- **Scale bugs found and fixed on the way:**
  - unbounded lookup batches (P1001) → `RECONCILER.lookupConcurrency` (`d923837`);
  - IN lists over 32,767 bind variables → `= ANY($1::uuid[])` (`cb0a623`);
  - the code-suffix trigger scanned the tenant per colliding row → migrations 0029 (index range) and 0030 (per-base
    counter, `ci_code_counters`) (`d18772e`, `a5c403a`, T-457);
  - Postgres `/dev/shm` 64 MB → 1 GiB in compose (`POSTGRES_SHM_SIZE`) and Helm (`postgres.shmSize`) (`83dfebc`);
  - a CI reported twice in one result became two CIs → one CI (`8cad55e`, T-008);
  - the estate gave ten HQ floors one subnet (`96721ec`) and drew one MAC for two hosts (`4a4173d`); the 0.05 estates
    are byte-identical (T-450 now checks the full-scale estate);
  - jsonb-containment lookups planned as sequential scans → migration 0031, `cis.identityTokens` with a trigger and a
    partial GIN index, probed 250 values per array overlap (`b124678`, T-458);
  - the outbox targets now receive a batch concurrently (`c0a121f`).
- **Host note:** from the Windows host, cold bursts of Prisma connections through Docker Desktop's port forwarding can
  exceed the 5 s connect timeout, so the replay ran with `connect_timeout=30` in `POSTGRES_URL` (project memory).
- **Dev tenant replayed on the final code:** 28,221 created, 1 updated, 0 duplicates, 16 refs pending; phase 67 s (was
  238 s). Utilisation and history were reloaded. The utilisation reload (912 sample-only results) took 285 s, against
  212 s before: slower, and not yet looked into.
- **Follow-up:** REQ-CORE-020 (new, P1): an outbox claim safe for concurrent dispatchers (`FOR UPDATE SKIP LOCKED`), the
  concurrent-worker measurement, and the dispatch target whose rate falls as the stores grow (dispatch is now two thirds
  of the run).

**3. Tracker CLI writes Decisions and Contracts** (`4b1e7b0`, REQ-CORE-007, T-456).

- `pnpm tracker decision ADR-xxx` reads title, status and date from the ADR header; flags override.
- `pnpm tracker contract <name> --version x.y.z [--adr]` records a contract version.
- Recorded so far: ADR-044, ADR-045 and ADR-046, and CI and collector at 0.7.0. ADR-006 to ADR-043 and the other
  contracts' versions are not recorded yet.

**4. gofmt:** `tools/simulator/internal/vendors/fcfabric/fcfabric.go` (`a2258ff`).

**5. Images:**

- `openmap/node:dev` and `openmap/scheduler:dev` were rebuilt and recreated; both node binaries carry 0.7.0, none 0.6.0.
- `openmap/reconciler:dev` was rebuilt on the final code and restarted.
- Postgres was recreated once, for `shm_size`.

**6. graphify:** a full refresh of the stale docs and screenshots (105 files, eight extraction agents) plus this
session's docs. The curated `GRAPH_REPORT.md` and `graph.html` are kept (project memory).

**Tests:**

- New: T-456 tracker, T-457 codes (integration), T-458 identity tokens (integration).
- Extended: T-008 (one CI per identity in a result), T-450 (full-scale estate), T-451, T-453 and T-454 (tenantRef within
  its vendor).
- Passing: reconciler unit 38 and integration 15, db 86, contracts 55, synth-estate 31, tracker 8, simulator verify package.
  Guard, `contracts:check` and `i18n:check` are green. (The simulator ran its `go test` suite, not a new 495-run
  verify.)

**Shared-folder note:** another session ran a `docker compose up` that restarted the stopped compose reconciler at
18:16:56. Its dispatcher claimed the dev replay's outbox, but no rows were duplicated (ClickHouse checked).

## Previous session · 2026-11-07 (checkpoint 27: reconciliation resolves `*Ref` values, issuer-scoped global keys)

Next-three item 1 of checkpoint 26, done as ADR-045 (REQ-CORE-013, REQ-QA-005).

**Three identity gaps closed:**

- **`*Ref` resolution.** A load balancer names a pool member by IP or FQDN; the host's agent names the same listener
  by the host's UUID or serial. Reconciliation now resolves every `*Ref` value to the id of the one CI it names, then
  matches on the tuple with refs resolved (the ref key).
  - It resolves through any of that CI's identity values, its name, its FQDN or address attributes, `serial:<serial>`
    or `name@version`. Identity values outrank aliases, and an ambiguous value resolves to nothing.
  - Rules: `IDENTITY_REF_TARGETS`, `IDENTITY_REF_ALIAS_ATTRIBUTES`, `IDENTITY_REF_DERIVED` in
    `packages/contracts/src/ci.ts`. Pure functions: `packages/contracts/src/identity.ts`, shared with the estate
    check and, through `ci-identity.json`, the Go harness.
- **Issuer-scoped global keys.** The ServiceNow and Workday tenants `horizonbank` no longer merge. A key that is unique
  only within its issuer is now global only with its scope keys (`GLOBAL_IDENTITY_SCOPES`):
  - `tenantId` by `vendor`;
  - `accountId` and `resourceId` by `provider`;
  - `clusterId` by `platform` or `engine`;
  - `moRef` by `platform`;
  - `contractNumber` by `vendorRef`.
- **Parent keys.** The new estate check found every Kubernetes namespace of a cluster merging on its cluster's UID.
  `PARENT_IDENTITY_KEYS` (`k8s_namespace.clusterUid`) now matches it only inside the tuple.

**Store and order independence (migration 0028):**

- New `cis` columns:
  - `refTokens` (GIN): every spelling a ref may name the CI by;
  - `refKey` (tenant btree): the tuple with refs resolved;
  - `refsPending` and `refsCheckedAt` (partial index).
- A trigger leaves a CI pending, with no tokens, when another writer inserts it or changes its identity (the wizard's
  sites, the register's contracts). The reconciler marks its own transactions with `set_config('openmap.ref_tokens', …)`.
- The reconciler reconciles each result in ref-depth order. Then `retryPendingRelationships` runs the ref pass first:
  tokens, pending refs round robin, and folding of CIs that share a ref key. Folding keeps the oldest CI and moves to
  it:
  - identity, attributes and tags;
  - relationships (re-pointed);
  - parts, external ids and the asset record.

  The copy is retired with `openmap.ci.retired` (`mergedInto`), and dependents re-resolve.

- Each result also folds its own new ref keys.
- New span `reconcile.identity_refs` and counter `openmap_reconciler_identity_refs_total{action}`.
- **NGINX:** upstream members were keyed `protocol: http`; they are now keyed `tcp`, like every other observer
  (`applicationProtocol: http` attribute, T-455).
- **Contract versions:** CI 0.7.0 and collector 0.7.0 (they move together; the Go `contract.Version` in apps/collectors
  and apps/node is checked against both). No payload field changed.

**Results:**

- `pnpm --filter @openmap/simulator verify`: 495/495 pass; 66,565 CIs and 82,379 relationships reproduced; identity
  drift **0** (from 284), relationship drift 0 (`docs/evidence/simulated-mode.md`, `.json`).
- Tests:
  - T-451 contract rules (9);
  - T-452 reconciler rules, folding and re-pointing (8);
  - T-453 integration on the compose Postgres (3): one listener either order, the fold with retire event and moved
    links, the two tenants, the trigger;
  - T-454 Go harness, plus synth-small has no self-merges;
  - T-450 the generated estate has no self-merges;
  - T-455 NGINX.

  Every other reconciler, contracts, db, collectors (contract, manifests, nginx) and node test passes. Guard,
  `contracts:check` and `i18n:check` are green.

- **Dev tenant replay** (`.local/estate-044`, `--reset`):
  - 28,221 CIs created and 1 updated: the estate holds 28,221 distinct CIs, because the `Microsoft` vendor is in both
    the agent-sam and the saas results (the ADR-044 replay showed the same split);
  - the five SaaS tenants are five CIs;
  - 0 conflicts, 0 folded, 0 duplicate identities, 0 pending relationships;
  - 258 refs resolved in the pending pass;
  - 18 refs stay pending and name no single CI: the two `horizonbank` tenantRefs (ambiguous between the vendors), the
    DHCP server and four rooms' buildings, which the estate does not hold as CIs;
  - phase 243 s, 116 CIs/s. The ADR-044 replay ran at 145 CIs/s on the same machine with other work running; persist
    totals over the same results were 40.4 s then and 44.1 s now.

  Utilisation (`.local/estate-044-util`) and health history (`replay-history --reset`) were reloaded, and the compose
  reconciler was rebuilt and restarted on this code.

- **Not changed (follow-ups):**
  - A `saas_application.tenantRef` names its tenant by id only, so two vendors' tenants with one id leave it ambiguous.
    Resolving the ref within the application's vendor would settle it.
  - The tracker CLI has no command for the Decisions and Contracts sheets, so ADR-045 and CI 0.7.0 are recorded in
    docs/adr and docs/CONTRACTS.md only.
  - `tools/simulator/internal/vendors/fcfabric/fcfabric.go` is not gofmt-clean (already in HEAD).
  - The node and scheduler images still carry contract 0.6.0 until they are rebuilt.

## Earlier session · 2026-11-07 (checkpoint 26: estate aligned with the collectors, older db failures fixed)

Syed's direction: fix the two older failures, then align the synthetic estate with the collectors (question 04).

**Older failures (dcbf78d):**

- The db schema and migration tests still expected `support_contracts` and `SupportLevel`, which migration 0023
  dropped. They now count tables created minus dropped and replay type creates and drops in order.
- The dev database held a CRLF checksum for 0015 (applied from a CRLF working copy; the committed file is LF and
  unchanged). The migration runner now rewrites a checksum that differs only in line endings and still reports a real
  edit (T-447). 0015 was repaired on the dev database.

**Estate aligned with the collectors (ADR-044, T-448…T-450):**

- The harness now judges drift with the reconciler's own rules, emitted as `packages/contracts/schemas/ci-identity.json`.
  It also reports relationship drift, and it reads addresses the collector dialled on loopback as the estate's target
  names (`Run.Aliases`). Under these rules the old estate drifted in 7,894 CIs and 524 relationships; the 36,373 of
  checkpoint 25 came from a stricter check than the reconciler applies (an IP address in another VRF still merges on
  its address).
- The generator now writes the collectors' identities:
  - network-device children use `serial:<serial>`;
  - hypervisors use the host FQDN and the platform's moRef or UUID, and clusters vCenter's `domain-c<n>`, Prism's UUID
    or Hyper-V's GUID;
  - the relationships read `hypervisor hosted_on host`, `vm runs_on hypervisor` and `os installed_on host`;
  - a Windows OS identity carries its build;
  - software is `name@version`, `member_of` its software;
  - CNAME targets carry the trailing dot, LUN WWNs the array's NAA OUI, ARNs each AWS service's form;
  - a fabric takes its principal switch's WWN;
  - SaaS tenant ids take each vendor's shape, and products the name the vendor API reports;
  - each Kubernetes tier is labelled by its component.
- Where collectors disagreed among themselves, the majority won:
  - SSH now links an OS `installed_on` its host;
  - WMI, SSH and the agent all link `instance installed_on host` and `instance member_of software`. Before, SSH and the
    agent had no software link, so vulnerability queries found no hosts on discovered data;
  - the agent's `softwareRef` is `name@version` (T-449).
- The simulators serve the estate's ids: vCenter moRefs, Prism and Hyper-V cluster ids, ARNs and SaaS tenants (SaaS
  is now verified against the estate's own tenants). The Brocade `fabricshow` lists the whole fabric.
- The assistant's grounding follows the stored directions (`Vm RUNS_ON Hypervisor`, `Hypervisor HOSTED_ON Host`,
  `OperatingSystem INSTALLED_ON Host`).
- Result: 495/495 runs pass; 66,565 CIs and 82,379 relationships reproduced; identity drift 284, relationship drift 0. What is left is load-balancer pool members (`listening_service` keyed by member IP or FQDN where the
  host's collector uses its serial). Fixing that needs reconciliation to resolve `*Ref` values to the referenced CI,
  which is a product change (see Next three).
- The dev tenant still holds the old estate. Replay a regenerated estate with `--reset` before the assistant
  evaluation, because "VMs per host" now walks `runs_on`.

## Earlier session · 2026-11-07 (checkpoint 25: rows parked, simulated mode, warranty lookups)

Syed's direction: no vendor access yet, so park the rows that need it and test the solution in simulated mode; return
to them later.

**Parked:** 28 rows set to Blocked with the reason in each row's notes: REQ-DISC-001…023/026/027/031 and
REQ-CMDB-022/024. Simulated runs add test ids to them but never close them (ADR-042).

**Simulated mode (REQ-QA-005 Done, ADR-042):**

- `tools/simulator` (Go module in go.work) has 39 vendor simulators on 7 protocol servers (SSH, WinRM,
  SNMP v1/v2c/v3, LDAP, DNS AXFR/TSIG, flow export, TCP banners), rendered from the synthetic estate, with real auth
  and pinned TLS.
- `pnpm --filter @openmap/simulator verify` builds and runs the real collector binaries and compares them with the
  estate. With contract checks on, 495/495 runs pass: 66,565 CIs and 82,331 relationships
  (docs/evidence/simulated-mode.md, T-350…T-446).
- Compose profile `simulated` (`docker-compose.simulated.yml`) plus `scheduler plan:submit` run the same jobs on the
  real Discovery Node. Warranty, SaaS and Pure went through node → scheduler → reconciler → console.
  Commits: 8856e83, 2006332, 899522b, f78acbd.

**Warranty and EoX (REQ-CMDB-024, ADR-043, contracts 0.6.0, 2714e27):**

- `warranty` collector: Dell TechDirect, Lenovo v2.5, Cisco SN2INFO plus EoX.
- `endOfLifeFromAttributes`; the reconciler and API carry the asset end of life (vendor-sourced only).
- `scheduler warranty:plan` plans the lookups from the CMDB.
- On the dev stack, 769 Dell, 517 Lenovo and 135 Cisco assets now carry vendor-verified warranty, and Cisco end of
  life shows on the Lifecycle screen. HPE and IBM are not built (no documented API shape).

**Collector bugs fixed (40+, each with a test), the most consequential:**

- 16 collectors ignored `caCertPem` on token, login or API transports.
- 12 collectors emitted attribute maps or object lists the scheduler rejects; the runtime now normalises them
  (`ContractAttributes`).
- The API silently dropped manifests the contract rejected: underscore ids, OCI/Alibaba families, Google/OCI/Alibaba
  credential types. Contract 0.6.0 and migration 0027 fix this; T-359 guards it.
- Paging stopped early in AWS, Alibaba, Google and NVD.
- F5/Citrix VIP collisions; UCS `extIp`; OneView names; Liebert UPS classified as cooling; Windows NAS/DHCP server
  identity.

**Open finding:** the synthetic estate's identities drift from the real collectors in 36,373 matched CIs: VRFs,
virtualisation ids and directions, the SNMP `deviceRef` form, load-balancer members. Real discovery would duplicate
those estate CIs. Question 04 below. The dev tenant now holds the simulated warranty and SaaS results; four SaaS
tenants were added rather than merged (tenant-id drift). Replay with `--reset` to restore.

## Earlier session · 2026-11-07 (checkpoint 24: CMDB complete bar credentials, discovery fixtures from a container lab)

Syed's direction: finish all CMDB rows and the discovery rows in review; lifecycle source option (c) (bundled
endoflife.date snapshot plus vendor EoX APIs).

**CMDB: 40 of 42 Done.**

- REQ-CMDB-014 parts and components (ADR-037, a136cb9): `ObservedCi.components`, `ci_components` (migration 0025) with
  removal, replacement and move by serial, `openmap.component.changed`; SSH, WMI and Redfish collect parts; Parts tab
  and Parts register. CI/collector contract 0.3.0, GraphQL 1.15.0.
- REQ-CMDB-021 layer visibility (a136cb9): Assets, Impact and Dashboard honour per-device visibility with one notice.
- REQ-CMDB-034 resource utilisation (ADR-038, 6b73f02): `utilisation.ts`, collectors sample CPU, memory, disk and
  power, Utilisation screen and tab; synth `utilisation-history` (712,500 samples replayed). Contracts 0.4.0, GraphQL
  1.16.0.
- REQ-CMDB-023 / 025 lifecycle (ADR-039, 41bd64e): `lifecycle_entries` (migration 0026), bundled snapshot
  `packages/db/lifecycle/endoflife-date.json` (34 products, 673 releases, fetched 2026-11-07) loaded by `migrate`;
  admin sync only where outbound calls are allowed; Lifecycle screen. Contracts 0.5.0, GraphQL 1.17.0.
- REQ-CMDB-022 SaaS (ADR-041, d435514): SaaS inventory read model and screen; synthetic SaaS tenants (the SaaS layer is
  populated). In review: needs recorded responses from real tenants.
- REQ-CMDB-024 warranty/EoX vendor APIs: Blocked on credentials and recorded responses (no guessed response shapes).

**Discovery: 5 of 31 Done.** A background agent ran a container lab: 45+ recorded fixtures from real products
(353d33d, ccfd67b, 2294914; `docs/evidence/vendor-fixtures.md`), 13 parser bugs fixed, StartTLS, SNMP v1, a Docker
Engine collector, an Oracle prober (go-ora, ADR-040), NVD API captures. REQ-DISC-024 and 025 closed; every other row
records its tests and exactly which vendors still need hardware, licences, accounts or the code-signing decision.
SQL Server Developer was run under Microsoft's EULA (`ACCEPT_EULA=Y`) for the capture.

## Earlier session · 2026-11-06 (checkpoint 23: receiving, vendors and contracts, certificates)

Syed's direction: keep going with the remaining CMDB rows. The dev stack is back after a Windows restart.

**Closed in the tracker:** REQ-CMDB-033, 036 (import and export) and 017, 019 (depreciation, spare stock), commit
80d90d6; REQ-CMDB-020 (receiving), commit f2ce51d. The e2e run that closed them also fixed two things: the API's CORS
now exposes `content-disposition` (the export kept a fallback file name), and asset edit buttons are located exactly.

**Committed, tracker closure queued** (Excel holds `tracker/OpenMap-Tracker.xlsx` open, so every `pnpm tracker set`
fails with EBUSY; close Excel and run `bash .local/tracker-queue.sh`, then commit the workbook and summary):

- REQ-CMDB-026, 027, 028, 029 — vendors and contracts, commit 2f2762e, tests T-181…T-185, evidence
  `docs/evidence/commercial.md`.
- REQ-CMDB-032 — certificates, commit 7076134, tests T-186…T-191, evidence `docs/evidence/certificates.md`.

What was built:

- **Receiving (ADR-034, REQ-CMDB-020).** ADR-005 keeps purchase orders in the finance system; a plan's BOM is the
  line list. `receivePlanLine` takes a line's oldest planned units into stock with serials, tags, the receipt day,
  the ERP reference and a storage location; the line counts them; an approved plan moves to building
  (migration 0022: `asset_records.bomLineId`, `plan_receipts`). The reconciler lets a new CI claim the received unit
  with its serial (deployed, no second register row). GraphQL 1.12.0, event 0.8.0.
- **Vendors and contracts (ADR-035, REQ-CMDB-026…029).** Vendors, contracts and cost centres are CIs. Migration 0023
  drops the unused `support_contracts` table; an asset's support contract is the covering contract CI (2,269 dev
  assets no longer flagged as missing support), kept in step with `covered_by` by `refreshCoveringContracts`
  (packages/db; reconciler and API). GraphQL 1.13.0: contracts (kinds, renewal, notice date, documents by
  reference), vendors with escalation contacts, cost centres (cost centre, department, customer) and the mutations;
  the console's Vendors and contracts screen and the asset panel's contract and owner.
- **Certificates (ADR-036, REQ-CMDB-032).** The BSM engine raises `openmap.certificate.expiring` once per certificate
  at 60, 30, 14, 7 and 1 days and on expiry (migration 0024 `certificate_alerts`, event 0.9.0); GraphQL 1.14.0
  `certificates(filter)`; the console's Certificates screen under Insight. The dev estate has no certificates from
  discovery (the synthetic estate does not generate them); the e2e imports two through the pipeline.
- **Sign-in at 127.0.0.1 (e4d6d80).** `PUBLIC_CONSOLE_ALIAS_URL` (compose default `http://127.0.0.1:3000`) is
  accepted by Keycloak's console client and the API's CORS; the running realm was updated through the admin API.

Migrations through 0024 are applied to the dev database (0015 reports a checksum mismatch that predates this work).

**Next CMDB rows:** 023 OS inventory and 025 EoX need a lifecycle catalogue (see Questions for Syed); 021 layer
visibility on the remaining screens, 014 parts, 034 utilisation can proceed without it.

## Earlier session · 2026-11-05 (checkpoint 22: CMDB import and export, depreciation and spare stock)

Syed's direction: keep going with the remaining CMDB rows.

**Committed, not yet closed in the tracker.** b5430f2 carries REQ-CMDB-033, REQ-CMDB-036 (ADR-032, GraphQL 1.10.0)
and REQ-CMDB-017, REQ-CMDB-019 (ADR-033, GraphQL 1.11.0, event 0.7.0, asset 0.4.0). The four rows stay "Not
started" in the tracker until their e2e specs run.

- **Import and export (ADR-032).** `previewImport` / `runImport` read CSV or XLSX (base64, `IMPORTS.maxFileBytes`),
  map columns to import targets, recognise a ServiceNow `cmdb_ci` export and refuse unknown classes per row. Accepted
  rows go to the results queue as `import` observations in chunks with one run id (a job id per chunk). The
  reconciler merges them at `importSeedConfidence` (0.6), so they fill gaps and never overwrite discovery. Imported
  CIs start managed. `ImportJob` (migration 0021, applied to the dev database) and `importJobs` report what each
  run created. `GET /export/cis` streams CSV with a byte-order mark, XLSX or JSON for the CMDB filter, and the CSV
  re-imports unchanged. The console exports from the CMDB screen and imports on `/cmdb/import`.
- **Depreciation and spare stock (ADR-033).** `bookValue` in the asset contract (straight line, double declining
  balance, floored at the residual, whole months). The register exposes `depreciation`, `bookValue` and `stock`, and
  `AssetDetailsInput` edits them with a per-field audit. `AssetFilter.belowReorderPoint` and the matching summary
  count find low spares. `openmap.asset.stock.low` fires once when a spare reaches its reorder point, on creation or
  update. The console form has depreciation and stock groups and shows today's book value. The register has a book
  value column, a low-stock mark and a low-stock filter.
- **Tests.** Passing: T-169 (import contract), T-170 (import and export integration, 2 of 2), T-171 (import screen,
  en+ar, 5 of 5), T-173 (book value, 3 of 3), and the asset screen suite (21 of 21, including the new value and
  stock case). Written, waiting for the stack: T-174 (value and stock integration in `api.integration.test.ts`),
  T-172 (`e2e/import-export.spec.ts`), T-175 (`e2e/asset-value.spec.ts`).

**Blocker: the dev stack is down.** The Docker engine hung during the image rebuild (API 500, ping timeout), and
`docker desktop restart` left it stopped. On every start since, the backend crashes on a Unix-domain socket it cannot
remove (`dockerInference`, then the secrets engine's `engine.sock`: "The file cannot be accessed by the system").
A plain Node `net.listen` on a socket path in `%TEMP%` also fails with EACCES, so AF_UNIX sockets fail for every
process on this machine, not only Docker. Docker's old `run` folder was renamed to `run.stale-20261105` (nothing
deleted). Docker Desktop shows an error dialog offering "Reset to factory defaults": do not take it, it wipes the
dev stack's images and volumes. A Windows restart is the expected fix.

**To resume after the restart:**

1. Start Docker Desktop and check `docker info`, then from `deploy/compose` run
   `docker compose -f docker-compose.yml -f docker-compose.apps.yml --profile cpu --profile node build api console reconciler`
   and `up -d --force-recreate api console reconciler`.
2. Run T-174 with `pnpm --filter @openmap/api exec vitest run --config vitest.integration.config.ts src/api.integration.test.ts`.
3. From `apps/console`, run `pnpm exec playwright test e2e/import-export.spec.ts e2e/asset-value.spec.ts e2e/assets.spec.ts e2e/cmdb-edit.spec.ts e2e/custom-fields.spec.ts --reporter list`.
4. Copy the screenshots `import-preview-*`, `import-jobs-*`, `asset-value-register-*` and `asset-value-details-*`
   to `docs/evidence/console/`, and write `docs/evidence/import-export.md` and `docs/evidence/asset-value.md`.
5. Close REQ-CMDB-033 and REQ-CMDB-036 with T-169, T-170, T-171, T-172. Close REQ-CMDB-017 and REQ-CMDB-019 with
   T-173, T-174, T-175. Use evidence b5430f2, then run `pnpm tracker report`.

**Next CMDB rows after that:** 020 purchase orders and receiving (BOM lines already carry `received`), 026 support
contracts, 027 vendors and contacts, 028 cost centres, 029 general contracts and documents, 032 certificates, 023 OS
inventory, 025 EoX, 021 layer visibility, 014 parts, 034 utilisation.

## Earlier session · 2026-11-05 (checkpoint 21: discovery re-statused, dependency mapping, network topology)

Syed's direction after checkpoint 20: finish the pending discovery and collector, application dependency mapping and
CMDB rows before BSM-007 or finance.

**Done.** REQ-DEP-002 (ADR-029), REQ-DEP-001 (ADR-030), REQ-DEP-004 (ADR-031), REQ-DISC-030 (closed on existing
evidence), REQ-CMDB-013, REQ-CMDB-016, REQ-CMDB-018, REQ-CMDB-015. The dependency workstream is complete (5 of 5).

- **Discovery rows re-statused.** REQ-DISC-001…027 moved from "In progress" to "In review": every collector is built
  and tested against protocol-shaped fixtures (Go suite 40 packages ok); each becomes Done once a recorded vendor
  fixture is captured and parsed (R-004, the vendor-lab dependency on Syed). REQ-DISC-030 (unknown devices with
  sysDescr/banner, label and promote) was already delivered by the register work (b63f25e, cf5a4c0) and is Done with
  T-018, T-042, T-100, T-128, T-129, T-130.
- **Application dependency mapping (REQ-DEP-002, ADR-029).** `apps/reconciler/src/core/adm.ts` joins flows
  (`communicates_with`, both dialects: netflow ip → ip and resolved compute → listener), address owners (`uses_ip`),
  listeners with their process (`listening_service` + `runs_on`) and components into `depends_on` edges: compute →
  listener (0.9), compute → compute when no listener serves the port (0.6), component → component (0.85, or 0.6 and
  `ambiguous` when the client runs several), each with its evidence (protocol, ports, flows, bytes, exporters,
  addresses, processes, window). `worker/adm.ts` runs the pass through the pipeline as the `adm` source (versioned,
  outbox fan-out), refreshes every edge's evidence and confidence in batched statements, retires edges the flows no
  longer support, and emits `openmap.dependency.derived` (event 0.6.0). It runs after results carrying flows,
  addresses, listeners or components (debounced per tenant), at the end of a replay, and on `pnpm --filter
@openmap/reconciler adm`. On the dev estate: 7,587 edges (7,434 listener, 148 component, 5 compute) from 7,495
  flows in 2.7 s; a second pass creates none and refreshes all in 0.7 s. The Dependencies side panel lists the focus
  CI's observed traffic with its evidence.
- **Network topology (REQ-DEP-001, ADR-030).** `networkTopology(layer, siteId, includeHosts)` (GraphQL 1.6.0): L2
  from LLDP/CDP neighbour links between device interfaces plus host cabling on request, L3 from device addresses in
  subnets, a site through `located_in`; one link per node pair with interface pairs, protocols, media and slowest
  speed; capped by degree. The Dependencies screen switches between the impact map and the topology (`view=topology`),
  with layer, site and hosts in the URL, the same Sigma canvas and worker, and a device's links in the panel. L2 on the
  dev estate: 252 nodes, 459 links, 58 ms.
- **Layered application map (REQ-DEP-004, ADR-031).** `applicationMap(id)` (GraphQL 1.7.0): an application's
  business services, components by tier (`APPLICATION_MAP.tierOrder`), every placement through `runs_on`/`hosted_on`
  with parent and hop, and dependencies classified internal, outbound and inbound with the far application and the
  derived evidence. The Dependencies screen's third view (`view=application`) draws a grid: tier columns, layer rows,
  layer chips that hide rows (URL), and the dependency panel. `aml` on the dev estate: three tiers, ten dependencies,
  21 ms. No dev-estate component runs on a cloud resource, so no test draws a cloud row yet.
- **CMDB audit and first rows.** An audit of the 20 open CMDB rows against the code found one nearly closable
  (018), eleven partial and eight missing: most planned mappings are contract or Prisma fields nothing reads or
  writes (stock, depreciation, support contracts, vendor contacts, customFields). Done now: `setCiLifecycle`,
  `setCiTags`, `ciTags` (GraphQL 1.8.0), CMDB type/lifecycle/tag filters, lifecycle and tag editors on the CI detail
  (REQ-CMDB-013, REQ-CMDB-016), and the e2e that changes an asset stage and finds it in the audit trail (REQ-CMDB-018).
  T-161 (API), T-162 (console), T-163 (e2e en+ar). Evidence `docs/evidence/cmdb-editing.md`.
- **Custom fields (REQ-CMDB-015).** Contract `custom-field.ts` (one validator for API and console), migration 0020
  (`custom_field_definitions`, `cis.customFields` JSONB with a GIN index, never written by the reconciler), GraphQL
  1.9.0 (`customFieldDefinitions`, `upsertCustomFieldDefinition`, `deleteCustomFieldDefinition`, `setCiCustomFields`,
  `Ci.customFields`, `CiFilter.customFields`), Settings card, CI detail card, CMDB filter. T-164..T-168. Evidence
  `docs/evidence/custom-fields.md`. The import contract (`packages/contracts/src/import.ts`, T-169) and the
  reconciler's import-source confidence landed in the same commit as groundwork for REQ-CMDB-033/036.
- **Tests.** T-157 (application map, 2), T-158 (through GraphQL, 2), T-159 (view, 7), T-160 (e2e, en+ar). T-149 (derivation, 6), T-150 (pass against Postgres, 2), T-151 (traffic panel and reading, console), T-152
  (e2e dependencies, en+ar), T-153 (topology folding, 3), T-154 (topology through GraphQL, 2), T-155 (topology view
  and circle seed, console), T-156 (e2e topology, en+ar). Reconciler 27, API 34, console dependency and layout suites
  33, guard, i18n, contracts, console lint green. Evidence: `docs/evidence/dependency-mapping.md`,
  `docs/evidence/network-topology.md`, `docs/evidence/application-map.md`,
  `docs/evidence/console/{dependencies-traffic,topology-l2,topology-l3,application-map}-{en,ar}.png`.

**Lessons.** (1) A force layout seeded from lanes cannot leave the row when every node shares one layer: seed such
maps on a circle. (2) A Next.js server page must not call a function exported from a `'use client'` module (the
route renders an application error); keep URL parsers in server-safe modules. (3) A URL-driven checkbox only flips
after the navigation: Playwright `check()` fails, click and wait for the URL. (4) Format ports with `String`, not the
locale integer formatter ("8,443"). (5) The CONTRACTS.md GraphQL row had kept 1.4.0 as its current version through
1.5.0; it now says 1.6.0.

## Earlier session · 2026-11-05 (checkpoint 20: the conversational assistant, increment two)

**Done.** REQ-AI-008 (ADR-028 accepted and implemented in full).

- **Conversations are records.** Prisma 0019: `assistant_conversations` (tenant, owner, title = first question
  clipped) and `assistant_turns` (question, locale, outcome `answered`/`clarified`/`failed`, the answer JSON as
  returned plus the resolved reading as `context`; `assistantTurnAnswerSchema`, assistant contract 0.2.0). The API's
  `ConversationsService` records every turn from `AssistantService.finish`, opening a conversation when the question
  came without one; `askAssistant(question, locale, conversationId)` returns `conversationId` and `turnId`; queries
  `conversations`, `conversation(id)` (turns through a field resolver, CIs resolved by id on read) and mutation
  `deleteConversation` are scoped to the user who asked. GraphQL 1.5.0 (additive).
- **Follow-ups** (`apps/assistant/src/core/conversation.ts`): `isFollowUp` (a continuation opener, or short with no
  intent marker and only a fragment), `resolveFollowUp` (fills types, names, attribute, measurement, aggregate,
  grouping, filters, health, period, window and top-N from the previous turn; a swapped subject drops the previous
  names and scope and carries a measurement to the equivalent metric; the intent is re-derived from the merged
  entities by the classifier's own ladder, `deriveIntent`, with a previous marker intent only where it still fits),
  `turnContextOf` / `parseTurnContext`. Classifier fixes on the way: the grouping attribute is reported at its
  absolute offset (so "per site" is no longer a second subject) and a `range` entity reads rolling windows in both
  scripts ("over the last 7 days", "آخر ٧ أيام", "last week").
- **`metrics.series`**: ClickHouse `metrics` over a window ending `offsetHours` ago, averaged into
  `ASSISTANT.seriesBuckets`; summary kind `series` worded in en and ar (average, range, samples, latest, trend);
  a calendar period on a measurement is a rolling window of `ASSISTANT.rollingDays`. `metrics.latest` honours a named
  CI. Follow-up chips lead a latest-sample answer to its series and a series to a longer window.
- **Console.** The Assistant screen lists the person's conversations (open, continue, new, delete) beside the thread;
  the open conversation's id is `?c=<id>` in the URL, so a reload rebuilds the thread from the server; local turns
  and server turns are merged by turn id; a follow-up continues the conversation the first answer opened even before
  the URL has moved. 26 new i18n keys per locale.
- **Evaluation.** 30 single questions (series question added) and four multi-turn conversations: 38 of 38 through
  GraphQL (T-143/T-146). Tests: T-145 (assistant unit, 54), T-146 (series skill offline 2, integration 38), T-147
  (console view 14, en and ar), T-148 (e2e `assistant.spec.ts`, en and ar). Guard, i18n, contracts, console lint green.
  Evidence: `docs/evidence/assistant-conversations.md`, `docs/evidence/console/assistant-{followup,reloaded}-{en,ar}.png`.
- **Tracker.** REQ-AI-008 is Done (T-145..T-148, commit f19125d); the closure, the session row and the report were
  applied once Syed closed the workbook (it was open in Excel during the session). AI workstream: 4 of 8 done.

**Lessons.** (1) A group-marker hit found in a slice must be reported at its absolute offset before comparing it with
hits found in the whole text (the "per site" subject bug). (2) The synthetic estate's metric samples all sit at the
generator's instant, so any "last N days" series on the dev stack is the sample-less wording; series arithmetic is
tested against bucket rows instead. (3) In the console, local turns must stay visible across the router update that
moves the URL to the newly opened conversation, and a follow-up must use the opened id, not the URL's, until then.
(4) Playwright `getByText` on a short word such as "availability" hits the figures, the evidence and the chips: mark
the line under test with a `data-testid`.

## Earlier session · 2026-11-05 (checkpoint 19: the conversational assistant, increment one)

**Done.** REQ-AI-007 (ADR-028 accepted for increment one). REQ-AI-008 stays In progress (increment two).

- **Understand** (`apps/assistant/src/core/vocabulary.ts`, `intent.ts`): a bilingual catalogue (CI types, attribute
  families with the keys collectors write, the ClickHouse measurements, aggregates, grouping words, intent markers,
  periods, health, names, scope words) classifies the question deterministically with the matched terms kept as
  evidence; the model (`llm-intent.ts`) is asked for a JSON verdict only below `ASSISTANT.minIntentConfidence` and
  can fill gaps, never override.
- **Plan** (`plan.ts`): intent → skill steps with typed parameters, or a clarification (`needName`, `unknown`);
  "VMs per host" maps the counterpart to the hypervisor; a non-numeric attribute becomes a breakdown.
- **Retrieve** (`apps/api/src/assistant/skills/*`): `cmdb.attributes` (Postgres SQL: count, breakdown, avg/sum/min/
  max, grouped aggregates, relationship fan-out density; attribute keys from the tenant's discovered catalogue,
  scope words resolved against low-cardinality values), `metrics.latest` (ClickHouse latest sample per CI,
  aggregate or ranking with names), `services.availability` and `incidents` (ADR-024 services module), `impact` and
  `history` (graph closure, CI versions), `howto` (screen catalogue in i18n), `graph.query` (REQ-AI-001 kept).
  Each step: timeout, span, evidence (store, query, params, rows, duration, error); ambiguous names narrow to the
  types the question used, then ask back with choices that re-ask using the CI code.
- **Compose** (`compose.ts`, `guard.ts`, `prose.ts`): every summary worded through the catalogue in en and ar with its
  figures; `ASSISTANT_PROSE` lets the model reword under the grounding guard (numbers at any rounding, identifiers in
  the evidence, sentence budget) and falls back with `grounded: false`.
- **Follow up** (`followups.ts`): three next questions per intent.
- **Contracts.** GraphQL 1.4.0 (`AssistantAnswer` intent/confidence/figures/evidence/followUps/clarification/
  grounded, `askAssistant(question, locale)`), event 0.5.0 (`openmap.assistant.query.failed`), assistant 0.1.0
  (`packages/contracts/src/assistant.ts`). Metrics `openmap_assistant_questions_total{intent,outcome}`,
  `openmap_assistant_duration_seconds`.
- **Console.** `AssistantView` shows prose, intent and confidence, figures (Kpi), CI pills, evidence per step,
  Cypher and rows when a graph step ran, follow-up chips, clarification choices, the ungrounded note; the Impact
  screen passes the locale. 193 i18n keys per locale.
- **Evaluation.** `apps/assistant/src/eval/questions.ts` (29 questions, en and ar, Syed's two failures included),
  run offline by T-142 and through GraphQL against the stack by T-143 (`apps/api/src/assistant/
assistant.eval.integration.test.ts`): 29 of 29 through GraphQL in 45 s, English prose grounded, Arabic deterministic (ASSISTANT_PROSE_LOCALES=en on the CPU profile). Console T-144; e2e Assistant: 3 of 3 (setup, en, ar); Lighthouse: not re-measured (the Assistant screen carries no budget; the budgeted screens are untouched).
  Evidence: `docs/evidence/assistant-conversation.md`.

**Lessons.** (1) Parameterised SQL keeps the attribute key in `$n` bindings: evidence checks must read params too.
(2) A hypervisor and its host share a name in the synthetic estate: resolve names by the types the question named
before asking back. (3) Arabic accusative endings ("جهازاً افتراضياً") need per-word suffixes in the term matcher.
(4) The graphify commit hook (`--no-cluster`, `stage_fixed`) commits the raw graph.json; the curated report is ours.

## Earlier session · 2026-11-05 (checkpoint 18: uptime tile, register pages, subscription cover, assistant ADR)

**Done.** REQ-UI-036, REQ-CMDB-041, REQ-CMDB-042; ADR-027 accepted; ADR-028 proposed for REQ-AI-007/008.

- **Uptime tile (REQ-UI-036).** Widget kind `services.uptime`: the estate's availability this month weighted by
  observed minutes over the monthly availability report, the change against last month, services below target.
  First on the admin and CTO/CIO templates; migration 0017 inserted it first on existing dashboards of those
  personas. `estateAvailability()` in `dashboard/widgets.tsx`.
- **Register pages (REQ-CMDB-041).** `assetPage(filter, page, pageSize)` (GraphQL 1.2.0) with totals; the console
  keeps the page in the URL, resets on filter change, shows the error of a failed page. The cursor query stays.
- **Subscription cover (REQ-CMDB-042, ADR-027).** `subscriptionSchema` (provider, plan, start, end, credits with
  unit/currency/asOf, source) on `asset_records.subscription` (migration 0018 with backfill from CI attributes);
  `SUBSCRIPTION_CI_TYPES` take the `subscription` gap instead of `warranty`; GraphQL 1.3.0 (`SubscriptionCover`,
  `Credits`, `SubscriptionInput`, `AssetSummary.subscriptionExpired`); the reconciler sync, the labelling path and
  the manual form carry it; the details form shows the subscription group for those types. Collectors: Microsoft
  365 reads `directory/subscriptions` for the term per SKU; Azure reads the billing account and the credit balance;
  both tested with protocol-shaped stand-ins. Google, Salesforce, ServiceNow, Workday, AWS, GCP, OCI, Alibaba have no
  read API for terms or balances: manual entry, documented in the ADR. The synthetic estate emits terms on licences
  and a term plus credits on cloud accounts.
- **Assistant (ADR-028, proposed).** Conversation records, five levels (understand → plan → retrieve across Postgres,
  Memgraph, ClickHouse → compose with a numeric grounding guard → follow-ups and clarifications), skills for
  attribute statistics, measurements, availability, incidents, impact, history and how-to, a checked-in evaluation
  set in CI. "Trained for OpenMap" is the catalogue, examples and evaluation set, not weights; LoRA is the documented
  later step once a GPU host exists. Increment one is REQ-AI-007, increment two REQ-AI-008.
- **Tracker.** Rows REQ-UI-036, REQ-CMDB-041, REQ-CMDB-042, REQ-AI-008 added; the `next` list still leads with the
  old P0 discovery rows because 26 DISC rows sit "In progress" since the collector marathon; that is a prioritisation
  question for Syed (below).
- **Tests.** Console 239 (35 files), API integration 22/22, contracts 14, reconciler 6+20, synth 8, Go saas/azure ok,
  e2e assets + dashboard: assets 3/3 (pager, subscription save), dashboard 3/3 (uptime tile); Lighthouse: assets 0.97/1.0/1.0, dashboard 0.99/1.0/1.0. Evidence: `docs/evidence/dashboard-uptime-register.md`,
  `docs/evidence/console/{dashboard-uptime,assets-subscription}-{en,ar}.png`.

**Lessons.** (1) Playwright `isVisible({ timeout })` ignores the timeout: use `waitFor({ state: 'visible' })`.
(2) A generated end-marker insertion lands in whichever test precedes the marker; anchor on the test being extended.
(3) The console's `Kpi` prints value and unit in one text node: match by prefix in tests.

## Earlier session · 2026-11-05 (checkpoint 17: SLA assignment, uptime by period, incident response with RCA)

**Done.** REQ-BSM-006 and REQ-BSM-008 (ADR-024), plus the register paging fix (cf5a4c0).

- **History has one store.** The reconciler's dispatcher now writes every `openmap.bsm.health.changed` event as a
  `service_health_history` row (ClickHouse DDL 0004 back-filled the 12 earlier events); the API and the engine read
  availability from that table only. `@openmap/bsm-engine` gained the pure arithmetic (`core/availability.ts`:
  windows, unknown time out of the denominator, calendar months/quarters/years cut at local midnight in the tenant's
  zone, budgets and burn rate; `core/history.ts`: the shared ClickHouse reader) and the SLA decisions
  (`service/sla.ts`: breach incident once per window, at-risk alert at the burn-rate threshold, roll-over clear,
  response and resolution deadlines and misses).
- **SLAs are rows.** Prisma 0016: `slas`, `service_sla_assignments` (one per service), and on `incidents` the
  assignee, `slaId`, `respondBy`/`resolveBy`, the breach stamps, `closedAt`, `resolutionNote` and the RCA JSON. The
  engine evaluates every assigned service each tick (`evaluateSlas`, new metrics `openmap_bsm_sla_evaluations_total`,
  `openmap_bsm_sla_evaluation_duration_seconds`) and stamps missed targets on every open incident, delivering
  `incident.updated` to subscribed integrations.
- **API.** GraphQL 1.1.0 (additive): `Sla`, `AvailabilityPeriod`, `ServiceAvailability`, `Rca`, `IncidentEvent`,
  `ServiceHealth.sla`/`currentWindow`/`availability`, the full `Incident`, queries `service`, `incident`, `slas`,
  `availabilityReport`, `availabilityReportCsv`, mutations `assignIncident`, `resolveIncident`, `closeIncident`,
  `updateIncidentRca`, `upsertSla`, `deleteSla`, `assignSla`; event 0.4.0 adds `openmap.bsm.sla.at_risk`. The
  incident timeline merges audit entries (the global interceptor records every mutation) with the engine's events.
  `BsmFactsService.slaFor` moved from the outbox to the history; `Query.incidents` takes `serviceId`.
- **Console.** Business services: SLA select per row, window figure ("99.2% this month") in the met/missed tone,
  burn rate; the Uptime table (month / quarter / year, "to date", "Missed" tags, Export CSV); the SLA catalogue with
  create/edit/delete; incident cards with severity, state, deadlines, assignee, acknowledge / assign / resolve /
  close, the RCA form and the timeline; `/services/[id]` detail route. 118 new i18n keys in en and ar.
- **Synthetic history.** `synth-estate health-history` (deterministic outages per service and month) and
  `reconciler replay-history` (back-dated health events through the outbox plus resolved incidents with deadlines).
  The dev tenant carries 14 months for its 15 services (398 rows, 199 incidents); the 300-service k6 measurement used
  a temporary perf fixture (284 seeded services, 7,884 events) that was removed afterwards.
- **Tests.** T-132 availability (12), T-133 SLA decisions (6), T-134 synthetic history (3), dispatcher health rows,
  T-135 API integration (22/22 whole suite), T-136 ServicesView (15), T-137 ServiceDetailView (4), T-138 e2e
  `services.spec.ts` en+ar (3/3), k6 `availability-report.js` p95 629 ms on 299 services (budget 1,000 ms), guard ok,
  `contracts:check` ok, i18n in sync, Lighthouse on Services 1.0/1.0/1.0 with CLS 0 (fixed-height scroll regions
  for the list and the uptime table, as on Assets). Evidence: `docs/evidence/sla-uptime.md`, `docs/evidence/console/services-*.png`.

**Lessons.** (1) `@clickhouse/client` binds `{p:DateTime64(3)}` params as String: cast in SQL
(`toDateTime64({p:String}, 3, 'UTC')`). (2) A SELECT alias named like a column (`toString(ts) AS ts`) shadows the
column in WHERE. (3) Two outbox dispatchers (the compose reconciler and a local `replay-history`) both claim the same
pending rows: the claim is read-then-update, not `FOR UPDATE SKIP LOCKED`; stop one before running the other (noted
under In progress for REQ-CORE-013). (4) `docker compose build` once produced no new image at all (same ids); run it
with `--progress=plain` to a log and compare image ids before `--force-recreate`. (5) Guard reads
`=> Promise<...>` on one .tsx line as JSX text: callback types live in `components/services/types.ts`. (6) k6 v2
consolidates `options` in `handleSummary`: read the VU count from `__ENV`.

## Earlier session · 2026-11-05 (checkpoint 16: the asset register follows the CMDB)

Syed's next statement: asset management must show everything the organisation owns across every layer plus the
unknown devices (with remediation or manual entry where a device has no out-of-band management), every asset with
warranty, support and end-of-life dates; then SLA assignment with continuous monitoring, alerting, incident response,
audit and RCA; then sites and their connectivity for HA/DR; later in the session: best-in-class uptime monitoring by
month, quarter and year, and the assistant to be grounded so it stops failing on questions like "OS per server
average" or "VMs per host" (REQ-BSM-008, REQ-AI-007 added). Done this session, ADR-023 (REQ-CMDB-039, REQ-CMDB-040):
the asset contract names the owned CI types; the reconciler creates one register row per owned CI in the same
transaction as the CI and refreshes what discovery observes on later sweeps without touching a person's entries
(array statements, tag fallback, unique per CI); migration 0015 backfilled the dev estate (9,481 rows: 2,000 hosts
with vendor warranty, 252 network devices, 26 licences with their expiry as subscription cover, 7,200 rows with at
least one gap); the API gained `assetSummary`, `assets(filter:)` (layer, type, stage, source, data gap, text),
`updateAsset` (audited per field, `openmap.asset.updated`) and `createAsset` (a CI through the outbox plus the row,
`openmap.asset.created`); labelling an unknown CI into an owned type registers it at once. The Assets screen is the
register per layer (strip with counts and gap counts, filters, cover columns with missing/expired tones, a details
panel with audit trail), the attention table, unknown devices with a rule-based diagnosis (`diagnoseUnknown`:
stale, SNMP power gear, SNMP device, unknown service on a non-standard port, no management, web-only endpoint) that
opens the label panel preset, manual entry for unmanaged equipment, and the plans. GraphQL is 1.0.0 (manufacturer
and model nullable is breaking), asset 0.2.0, event 0.3.0. Tests: T-127 (reconciler mapping), T-128 (diagnosis),
T-100 (view, en/ar), T-129 (e2e, en/ar), T-130 (API integration), T-131 (reconciler sync against Postgres).
Lessons: Python `write_text` on Windows turns LF into CRLF — write bytes; the i18n package must be rebuilt before the
console typecheck sees new keys; `pnpm contracts:check` reads the committed schema, so a breaking change needs the
major bump before the check passes. ClickHouse `ci_history.source_run_id` is a UUID column: a CI the API creates
must carry a UUID run id (the manual asset first stamped the literal `manual-asset`, and the one event poisoned every
ClickHouse batch of the dispatcher until it was fixed and the leftover test tenant purged). Docker Desktop's WSL engine
died during an image build and had to be restarted by hand; containers came back on their old images until recreated.

## Earlier session · 2026-11-05 (checkpoint 15: the Layers equipment scene and the formal profile)

Syed rejected the first Layers revision (holographic wafers and abstract glyphs, projected labels) as "horrible",
"game inspired" and unreadable, and asked for realistic objects (switches, firewalls, racks, servers, storage) with
vendor marks (VMware, Microsoft, Red Hat) and a final sweep to make the console formal. Done as ADR-021 (rewritten)
and ADR-022: the Layers screen is a three.js stack of twelve planes in contract order (Syed: "the initial layers
were better"); clicking a plane or its row zooms onto that layer, recedes the others and stands its schematic
equipment on the plane, with a focus panel (count, health, platforms, CMDB link) and Escape or Back to return;
equipment built from primitives (cabinets, a switch and firewall, 2U servers, a disk shelf and SAN switch, a hypervisor host with VM
cards, zone slabs, a console screen, a container host, database drums, an application tier, SaaS cards, a crate),
vendor marks beside each row of the list from `simple-icons` (CC0; names in chips where a logo is not licensable),
no text in the canvas, hover synced with the visibility list, an accessible tier list for the e2e (T-125, T-126). The formal
profile removed the holographic borders, HUD brackets, grid floor, aurora, sheens, rings, value glows and entrance
rises from `packages/ui`; cards are plain bordered surfaces with an opt-in float shadow; pills and bars glow only
on request; the sidebar active item is a quiet tint. Memory `ui-direction-obsidian-pro` carries the rules.

## Earlier session · 2026-11-04 (checkpoint 14: dashboard wizard, role templates, Horizon refinements)

Syed's next asks after the what-if fix: a dashboard wizard and customisation with real templates for Admin, CTO/CIO,
CISO and Finance; more professional type and floating effects; a Superset that matches the theme. ADR-020.
Contract `dashboard` 0.1.0 (five personas, twenty-four widget kinds, four sizes, templates), GraphQL 0.10.0
(`dashboards`, `estateStats`, create / update / delete / set default), migration 0014 `dashboards`. The API's
`EstateStatsService` composes the register, licence, vulnerability, plan, power, IPAM, Node, integration and incident
facts plus ClickHouse daily trends in one query. The console's `/dashboard` opens the wizard on a first visit
(persona → widgets and sizes → name and sharing → create), then renders the dashboard's widgets on a four-column
grid from live queries, with a switcher, Customize (add, remove, resize, reorder, save), share, default and delete.
`packages/ui` gained `Sparkline`, `Donut` and `Segmented`, the floating-surface tokens and rules (`om-float`,
`om-float-idle`, opt-in because a transform makes a stacking context), and Sora replaces Chakra Petch as the display
face. Superset is provisioned with the Horizon colour scheme and a dark dashboard CSS (ANALYTICS.theme). Tests:
T-123 view (en, ar), T-124 e2e (en, ar), ui 44. Three defects found on the way and fixed: the per-CI `health`
lookup, `WHERE c.id IN $ids` with a Bolt parameter list, is a per-node scan in Memgraph (1.0 s for 2,400 ids) where
`UNWIND $ids AS id MATCH (c:Ci {id: id})` hits the unique index (80 ms): the racks query went from 1.7 s to under
0.5 s, and the same query in the BSM facts service and the BSM engine is fixed alike; the `incidents` query failed on three incidents that named CIs a replay reset had
recreated (orphans are left out and logged; a reset now purges incidents, links and impact rows); the discovery
sweep card changed height when its query resolved (Lighthouse CLS 0.27 → 0.02). A stray kind cluster on the dev
machine (`openmap-control-plane`, not ours to remove) eats a core; stop it before a Lighthouse sweep. Queue after this (memory `openmap-requests-2026-11-04`): the
Layers screen as an isometric stack with 3D holographic icons (REQ-UI-033), the full asset register across every
layer (REQ-CMDB-017/018 and a new register row), the finance module (costing, ROI, budgeting; new BSM rows).

## Earlier session · 2026-11-04 (checkpoint 13: what-if scenarios failed on every run)

Syed reported "Something went wrong" on every what-if run in Business services. Root cause, found by replaying the
run in the browser pane: the console sends the picked condition (`failed`, `power_loss`, …) as the scenario `kind`,
and the impact contract's `SCENARIO_KINDS` still listed the pre-console scope kinds (`component`, `power`, `rack`,
…), so `saveScenario` rejected every input with `invalid ScenarioInput` and the screen showed only the generic error.
Fixed by ADR-019: the scenario kinds are the conditions plus `maintenance`, `SCENARIO_KIND_SEVERITY` gives each its
starting state, the console's condition table and the API's `severityFor` both read the contract (impact 1.0.0;
Postgres enum recreated by migration 0012, GraphQL unchanged). Validation errors now carry their zod issues in the
message, and the impact screen prints the server's reason under the error card. Two more defects sat behind it:
the scenario `runbook` the contract declares had no column, so every scenario read failed its parse (migration
0013), and the impact traversal never followed `contains`, so a component's failure never reached its application
or any business service (`contains` is traversed from logical containers only, `GRAPH.impactContainerTypes`; the
Memgraph integration test covers a component reaching its service and a port not taking down its switch). T-122
runs a model on cbs-db on the real stack in both locales and expects affected services. Lesson: a screen whose
unit test stubs the API needs one e2e that exercises its mutation for real, and a "0 affected" result is a finding,
not a pass.

## Earlier session · 2026-11-04 (checkpoint 12: Horizon look and the 3D digital twin)

Syed's customer called the console "generic, AI-generated"; he asked for a futuristic look and a real 3D digital twin
(MFA and the corporate IdP parked). REQ-UI-028 and REQ-UI-029 done (ADR-018, `docs/evidence/horizon-twin.md`).
Horizon lives in `packages/ui`: an `effects` token group (holographic border, HUD brackets, grid, aurora, glow, sheen,
rise, ring), `componentRulesCss` rules for cards, panels, KPI values, bars and dots, four new keyframes, Chakra Petch
as the display face; the console paints the ground on `html` with a perspective grid floor on `body::before`
(transform-only drift), a lit sidebar indicator, ruled section labels, a top-bar hairline and mono eyebrows with a
glowing lead line. Every existing screen inherited it. The twin at `/twin` (three.js, react-three-fiber, drei): the
`racks` query becomes rooms, racks and device plates at true proportions (pure `twin-model.ts`, T-119), a focus CI's
impact graph is lifted onto stacked layer planes with a node grid per plane and one line batch for the edges
(1,707 nodes for a host's OS on the dev estate), instanced meshes, on-demand rendering, orbit, hover, click to a rack's
devices or a node's CI, "Focus here". T-120 unit (en, ar), T-121 e2e (en, ar), walkthrough captures `/twin`.
Three lessons: a card entrance that fades from opacity 0 leaves Chrome without a first contentful paint on a page
whose content is all cards (the sign-in gate scored NO_FCP), so the rise moves without fading; a lingering transform
after the entrance makes a card a stacking context and hides dropdowns under later cards (fill-mode backwards);
animating background-position on the full-screen grid repaints every frame, so the drift is a transform.
Lighthouse: twin 0.96, every screen at or above its floor; CMDB-038 summary selection kept lean (checkpoint 10).
Follow-ups: the DCIM elevation still draws its isometric SVG and links to the twin; per-site platforms in the twin
need the site of a room, which the racks query does not carry yet.

## Earlier session · 2026-11-04 (checkpoint 11: initial setup wizard)

Syed asked whether a fresh deployment has an onboarding wizard; it had none (CLI node registration, no way to create a
subnet or a credential from the console), and he called that vaporware. REQ-UI-020 and REQ-UI-024 are now done end to
end (ADR-017, `docs/evidence/setup.md`): GraphQL 0.9.0 adds `onboarding` and ten administrator mutations; `/setup`
walks six steps, each a real write. Organization and business units (tenants with derived slugs); sites (row plus the
site CI through the outbox, facility columns in migration 0011, code immutable as the CI identity, removal retires
the CI); inter-site links (`site_link` CI `connected_to` both ends); Discovery Nodes (one-time token minted like the
CLI, enrol command printed from `DISCOVERY_NODE_ENV`); credential sets (validated against the new
`CREDENTIAL_FIELDS` in the collector contract, written to OpenBao KV v2, reference kept, values redacted in the
audit log; the API creates the `openmap` mount on first use because `openbao server -dev` only mounts `secret/`);
discovery scopes (subnet CI `located_in` the site with the credential as scope attributes, same CIDR updates);
integrations (existing editor embedded); generate (CIs completed, `generatedAt`, first sweep). The CI repository gained
`create`/`retire`/`findCurrentByIdentity` with the reconciler's identity key. Tests: T-118 (API integration, 20
passed), T-116 (SetupView unit, en+ar), T-117 (e2e setup, 3 passed on the rebuilt images), walkthrough captures
`/setup`. The dashboard shows a setup call to action until the twin is generated.
Observations: a sweep with no assignable targets stays "running" in the sweep view (no jobs, so no finishedAt);
the scopes table lists every subnet of the estate (111 on the synthetic tenant) and will need paging on large estates;
business-unit tenants still need their Keycloak tenant claim set by hand (REQ-SEC-009). Lighthouse: setup 1.00; the
run also caught DCIM at 0.87 because checkpoint 10 had put the headline metric into the shared CI summary selection,
which every screen fetches; the summary is lean again and the metric is selected only where rendered (DCIM 0.91).

## Earlier session · 2026-11-01 (finish-everything marathon, checkpoint 10: headline metrics)

REQ-CMDB-038 done end to end (ADR-016, `docs/evidence/cmdb/headline-metrics.md`). Metric samples now have a path:
`CollectorResult.samples` (collector contract 0.2.0, Go `Samples` with omitempty on node and collectors) → the
reconciler binds each sample's CiRef to an id, drops the unresolvable, emits `openmap.metric.sampled` (event 0.2.0,
≤ `RECONCILER.samplesPerEvent` per envelope, pending for ClickHouse only) → the dispatcher writes `metrics` → migration
0003 keeps `metrics_latest` current → `Ci.headlineMetric` (GraphQL 0.8.0) through a per-request ClickHouse batch
loader (span + `openmap_clickhouse_queries_total`) → the console shows it on every CMDB row, the CI detail header,
focus-search hits and the impact panel (`metric.<key>` in en and ar, contract unit, "No sample yet"). The synthetic
estate emits one headline sample per CI of a known layer plus subnet utilisation and PDU power (rack name label), so a
replay fills `metrics` (28,501 samples at scale 0.05, 0 dropped) and `subnet_utilisation_daily` for the first time.
The API serves a 50-row page with headlines in 21–76 ms end to end. The persist transaction got an explicit budget
(`RECONCILER.persistTransactionTimeoutMs`, 120 s): Prisma's default 5 s expired on a 2,000-CI result on this host.
Replay procedure: stop the compose reconciler first, or its dispatcher claims the outbox with whatever its image has.
Observations: the headline is per layer, so subnets and IPs show device traffic (a per-type override is a follow-up);
`power_by_rack_hourly` keys on the rack CI id in `labels['rack_id']`, which collectors cannot know, so the view stays
empty until the reconciler resolves CI references inside sample labels (follow-up for REQ-DCIM power from telemetry).

## Earlier session · 2026-11-01 (finish-everything marathon, checkpoint 9: the assistant)

Syed reported the assistant answering every question with `the query failed to run: Unbound variable: n`. Root cause:
the grounding prompt carried the fragment `WHERE n.tenantId = $tenantId` and an impact pattern with `{name:$name}`;
the 1.5B model copied both verbatim. Fixed in REQ-AI-001 (`docs/evidence/assistant.md`): the prompt teaches from six
complete, validator-checked examples and the stored relationship directions; `prepareCypher` normalises hops (a
reversed known hop is turned round, a wrong type between two labels linked by one type is replaced), scopes every
MATCH-bound node variable to `$tenantId` and `validTo IS NULL` deterministically, adds the LIMIT; the validator rejects
unbound variables, unknown labels / relationship types / node properties, backwards hops and health literals outside
`HEALTH_STATES` (new in `@openmap/contracts`, mirroring the GraphQL enum) with a message that names the fix. Golden set
(T-113, `pnpm --filter @openmap/assistant test:integration`, picks the most populated tenant): 12/12 on
Qwen2.5-Coder-1.5B — 10 answered, 2 refused because utilisation and power draw are not graph properties. The e2e
Assistant test answers in en and ar on the rebuilt API image (`docs/evidence/console/assistant-{en,ar}.png`). The
console's example prompts for subnets and power now ask graph-answerable questions. `llm-cpu` in compose had the
image's health check on the wrong port (unhealthy for 499 checks); it has its own check now and reports healthy.
Observation for BSM: all 15 business services are `unknown` in the graph and in the API's `services` query on this
stack — the engine has had no CI health events since the estate replay (REQ-BSM-001/002 behaviour to revisit with a
synthetic event feed; not an assistant defect).

## Earlier session · 2026-11-01 (finish-everything marathon, checkpoint 8)

Syed asked for every Not started / In progress / In review row to be finished, dependencies on his side listed first,
easiest rows first. Commits this session: `6e6a055` (telemetry in every service, layer visibility on every list),
`12dab7e` (software, licence and vulnerability queries, GraphQL 0.5.0, ADR-013), `46aeaae` (Software and
Vulnerabilities screens; the services' missing OpenTelemetry dependency), `bb5e5b9` (dependency map force layout and
blast-radius isolation; licence dates as ISO instants; console lint debt cleared and linted in CI), `0d660e0` (CI short
codes unique in Postgres and editable, GraphQL 0.6.0, ADR-014; ClickHouse and Prometheus scrape fixes; layout-shift
fixes on Assets and Software; per-scope discovery rate limits honoured by the planner) and `3b6b9e8` (discovery
scopes: GraphQL 0.7.0, ADR-015; scopes card on the Discovery screen; knowledge graph refreshed).

**What exists and runs** (everything from checkpoint 7, plus):

- `apps/console`: **Software and licences** (`/software`: catalogue with footprint, licence usage and posture groups,
  text and licensed-only filter) and **Vulnerabilities** (`/vulnerabilities`: CVSS-ranked CVEs with exploited /
  exposure / CVSS filters and a blast-radius panel: affected software, hosts, business services with predicted
  state). Dependency map: lane/force layout toggle in the URL (`?layout=force`, deterministic Fruchterman-Reingold in
  the layout worker up to `DEPENDENCY_MAP.forceMaxNodes`), click isolates a node's impact closure (Sigma reducers dim
  the rest), double-click opens the CI. CI short codes come from the API (`Ci.code`), show on CMDB rows, focus-search
  hits and the CI detail header, where operators rename them (`setCiCode`). Assets and Software tables sit in
  fixed-height scroll regions (CLS was 0.31 / 0.27; Lighthouse under 0.9 on both until this change).
- `apps/api`: `software`, `vulnerabilitySummaries`, `vulnerability` (ADR-013); `Ci.code` and `setCiCode` (ADR-014,
  409 on a taken code); date attributes normalised with `isoAttribute()` (the estate stores calendar dates; the
  DateTime scalar rejected them and emptied the Software screen on the shipped image); discovery scopes carry
  `rateLimitConcurrency` / `rateLimitRps` subnet attributes that the planner honours under the Node ceiling.
- `packages/db`: migration `0010_ci_code_unique` renumbers duplicate codes (499 groups on the dev estate, every IP
  address had collapsed to `NET-10`), adds a BEFORE INSERT/UPDATE trigger that suffixes a taken code and a partial
  unique index on `("tenantId", code) WHERE "validTo" IS NULL`. `ciCode()` now keeps dotted non-domain names apart.
- `packages/telemetry` on every Node service; Prometheus scrapes api:4000, reconciler:4100, scheduler:4201,
  bsm-engine:4400 (all `up` after the container picked up the current scrape file); ClickHouse metrics on 9363 through
  `deploy/compose/clickhouse/prometheus.xml`; Memgraph Community has no Prometheus endpoint (target removed, documented).
  `docs/evidence/telemetry.md`.
- Lint: the console had 48 pre-existing lint errors that broke `next build` (the Docker console image); fixed, a `lint`
  script added, `pnpm lint` added to the CI verify job, Next/Playwright output ignored by ESLint. Other packages still
  lint only under the root config (apps/api has 65 findings under it, mostly the Nest empty-class rule) — see Next three.
- Evidence: `docs/evidence/console/{software,vulnerabilities,dependencies}-{en,ar}.png` and `screens.md`;
  `docs/evidence/telemetry.md`; e2e `30 passed, 1 skipped` on the final images (the scope test included); Lighthouse: 1.0 on
  every screen except dcim 0.91 and analytics 0.76 (embedded floor 0.7), CLS 0 on Assets and Software after the fix
  (`docs/evidence/perf/lighthouse.json` now records FCP, LCP, TBT, CLS, speed index and TTI per screen).

**Tracker.** The workbook was locked by Excel through checkpoints 4–9, so the closures were queued in
`.local/tracker-closures.sh` (gitignored) with their test ids and evidence. Syed closed Excel after checkpoint 9 and the
script ran: 50 rows moved to Done (CORE-014/015/016/017/018, SEC-002/006/007/008/010, IPAM-001/002/006, DCIM-002/009,
PERF-001/003, INT-003/004/005/006/007/008, CMDB-001…012, CMDB-030/031/035/037, DISC-029, UI-015/016, BSM-001/002/003,
DEP-003/005, AI-001/004, QA-002). `pnpm tracker status`: 88 of 188 Done (47%), 28 In progress, 4 In review, 68 Not
started, 0 Blocked; `pnpm tracker verify` ok. The earlier "56 rows / 94" figure in this file was an over-count; the
tracker is the truth.

## Dependencies on Syed (nothing below can be finished without them)

| Need                                                                                                                                                                                                                      | Rows blocked                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/SPEC.md` (the planning document exported as Markdown)                                                                                                                                                               | re-seeding the tracker; frozen contracts checked against it; every "per SPEC" acceptance criterion                                   |
| Vendor lab or recorded transcripts (snmpwalk, SSH/CLI, WinRM, REST) for Cisco, Arista, Juniper, Dell iDRAC, HPE iLO, Lenovo, VMware, Hyper-V, Nutanix, Pure, NetApp, Dell EMC, Brocade/MDS, F5, Citrix, A10, APC, Liebert | REQ-DISC-001…027 Done (collectors exist, tested against protocol-shaped fixtures; R-004 forbids fabricating vendor data), REQ-QA-003 |
| Read-only cloud and SaaS credentials (AWS, Azure, GCP, OCI, Alibaba, Microsoft 365, Google Workspace, Salesforce, ServiceNow, Workday)                                                                                    | REQ-DISC-010, REQ-CMDB-022 Done                                                                                                      |
| A GitHub remote (or other CI runner) so the `verify`, `integration`, `e2e` and `kind` jobs run                                                                                                                            | REQ-QA-002/004, REQ-INT-003 evidence from CI, REQ-PERF-002/004 thresholds "enforced in CI"                                           |
| Warranty / EoX API credentials (Dell TechDirect, HPE, Lenovo, Cisco, IBM)                                                                                                                                                 | REQ-CMDB-024, REQ-INT-014                                                                                                            |
| Integration sandboxes (ServiceNow, Jira SM, Splunk/Sentinel, PagerDuty, Slack/Teams webhooks)                                                                                                                             | REQ-INT-009…017 Done beyond the recorded-fixture level                                                                               |
| Corporate IdP (SAML/OIDC) and the MFA decision                                                                                                                                                                            | REQ-SEC-009 Done                                                                                                                     |
| Decisions: ADR-006 (@peculiar/x509), ADR-007 (Sigma.js + graphology), per-business-unit tenancy, code-signing certificate for the release tarballs                                                                        | REQ-SEC-013, REQ-SEC-010 scope, REQ-DISC-031/004 Done                                                                                |

## In progress

- REQ-DISC-029 is complete in code (per-scope rate limits in the planner, `discoveryScopes` / `updateDiscoveryScope`
  in GraphQL 0.7.0 per ADR-015, the Discovery screen's scopes card with inline editing, T-010/T-067/T-112 and the e2e
  scope test); it moves to Done with the queued tracker closures. The scope builder now reads the CIDR from the subnet
  identity first: on the dev estate 106 of 107 subnets were invisible to a sweep before.
- REQ-CORE-020 (In review, ADR-050): leased claims, the pipelined graph batch, synchronous large ClickHouse inserts.
  Only the scale-1 measurement is left (checkpoint 30). REQ-PERF-004 (In review): the sweep meets its budget locally
  (8.43 min per 10k devices); it waits for the nightly CI run.
- REQ-AI-001 is complete in code (golden set 12/12, T-011/T-113/T-104/T-106); it moves to Done with the queued
  tracker closures. Test files of apps/assistant and apps/api are excluded from their tsconfig, so the root ESLint
  project service cannot parse them (`pnpm exec eslint apps/assistant/src` reports only that); part of the lint item.
- REQ-SEC-009 (in review): SAML brokering and MFA need a corporate IdP.
- REQ-DISC-031 / REQ-DISC-004 (in review): signed release tarballs.
- Lint debt outside the console: add `lint` scripts to every package and clear the root-config findings.

## Blocked

- Parked by Syed on 2026-11-07 (28 rows): REQ-DISC-001…023/026/027/031, REQ-CMDB-022/024. Each is exercised in simulated
  mode (test ids on the row) and closes only on real captures or access (see each row's notes).
- docs/SPEC.md still missing (risk R-001). Vendor lab fixtures (risk R-004). CI never ran (no remote).

## Next three

Syed's order (2026-11-05): discovery and collectors, dependency mapping and CMDB before BSM-007 and finance.

1. Next by `pnpm tracker next`.
2. The finance module. Parked rows close as vendor access arrives.
3. REQ-CORE-020 closure: the scale-1 replay with the new dispatch.
   - Measure on tenant `570b1953` with `replay --reset`, then rerun `replay-history --dir .local/estate-s1b --reset`
     and the assistant evaluation.
   - Or measure on a fresh seed. A second 550k tenant ties on business services and CIs, and the evaluation and
     `impact-budget` pick tenants by those counts.
   - Follow-ups:
     - the ClickHouse target under load (two transient insert failures at scale 0.25);
     - the 45 ms Memgraph stall per large statement;
     - a cloud-hosted application in the synthetic estate (ADR-031).

**Dev-stack notes (also in project memory):** the compose stack is running (apps overlay, `cpu` LLM profile, `node`
profile); `openmap/api:dev` and `openmap/console:dev` were rebuilt in checkpoint 29, `openmap/{scheduler,reconciler,node}:dev` in
checkpoint 28; migrations through 0036 and ClickHouse DDL through 0004 are applied to the dev database; `openmap/reconciler:dev` was rebuilt in checkpoint 30 (leased claims, `RECONCILER_DISPATCHERS` 1). Lighthouse must run alone on the CPU. Smoke tokens for the synthetic tenant need a
Keycloak user whose `tenant` attribute is `ac9a6a65-1f19-4ecf-bf16-b3a90e42cc5c`.

## Questions for Syed

6.  Answered on 2026-11-09: confirmed. REQ-BSM-007 reads "tier-1 site" as business criticality 1, a new site
    attribute; `tier` stays the facility's Uptime tier.

7.  Answered (c) on 2026-11-06; implemented as ADR-039.
8.  Answered on 2026-11-07: align the estate with the collectors; implemented as ADR-044.
9.  Parked rows stay parked. The simulated runs found and fixed 40+ collector bugs, but every vendor row still closes
    only on real access or captures (questions 01–03). Syed on 2026-11-09: vendor access is deferred to a later
    phase; the 29 Blocked rows are not chased until then.
10. REQ-CMDB-024: API credentials for Dell TechDirect, HPE, Lenovo, Cisco (SN2INFO and EoX) and IBM, so the warranty and
    EoX adapters are written against recorded responses.
11. REQ-CMDB-022: developer tenants or recordings for Microsoft 365, Salesforce, ServiceNow, Google Workspace, Workday.
12. Discovery rows 002, 005, 006, 008–010, 012–015, 026 (and the commercial vendors listed on 001, 011, 016–023, 027):
    lab access or recorded captures. 004/031: the code-signing decision for release tarballs.
    0a. Tracker priority: 26 discovery rows (REQ-DISC-003…031) have been "In progress" since the collector marathon
    and still head `pnpm tracker next`. Should they move to "In review" (collectors exist, vendor fixtures pending on
    the lab) so the next list shows the SLA, assistant and finance work you asked for?
    0b. Microsoft 365 and Azure: grant the read-only app registration `Organization.Read.All` (Graph) and a Billing
    Reader role on the billing account so the subscription term and credit balance flow in; Google Workspace terms
    need the Reseller API only if Workspace is bought through a reseller. 0. Analytics: the embedded Superset frame, once fully loaded, scores 0.67 on Lighthouse performance whatever the
    console does around it (its own 2.7 MB of script; ADR-026 lowered the embedded floor to 0.65 to state the cost).
    Should the Analytics screen become native ClickHouse charts in the console (REQ-UI-021/022/023 reports and BI)
    with Superset kept for ad-hoc exploration only? That is the only way to the 0.90 budget on that screen.

13. Export the planning document to `docs/SPEC.md` so the tracker can be re-seeded and the contracts frozen against it.
14. Access to the vendor lab (or recorded `snmpwalk`, SSH, WinRM, REST transcripts) for Cisco, Arista, Dell iDRAC, HPE
    iLO, VMware, Nutanix, Pure, NetApp, Brocade/MDS, F5, APC: nothing can be fabricated.
15. Confirm ADR-006 (`@peculiar/x509`) and ADR-007 (Sigma.js + graphology, MIT) as accepted dependencies; ADR-013 and
    ADR-014 are additive contract bumps (0.5.0, 0.6.0) recorded for review.
16. Confirm multi-tenancy is per business unit as drawn in onboarding.
17. Close the tracker workbook in Excel while sessions run (or we switch the tracker to a copy-on-write flow).
18. Answered on 2026-11-10: Percona `pg_tde` (all tables) plus OpenBao Transit for the few personal-data fields, in this
    order: production OpenBao (persistent storage, unseal, snapshots, monitoring) → verify pg_tde's state and measure
    → migrate to Percona PostgreSQL 17 with tde_heap → field encryption → encrypted backup files → ClickHouse encrypted
    disk. Original question: in transit is decided (the internal CA that already signs Node mTLS issues a
    certificate per service; Postgres, ClickHouse, Valkey, Memgraph, Meilisearch, Keycloak and OpenBao serve TLS only;
    ClickHouse at rest uses its built-in encrypted disk with the key in OpenBao). PostgreSQL has no built-in encryption
    at rest, so one choice is yours: (a) Percona's `pg_tde` (replaces the Postgres distribution, an ADR and a data
    migration), (b) volume encryption under the data directory (LUKS, BitLocker, a cloud KMS volume or an encrypted
    storage class in Helm), which OpenMap documents and the installer checks, or (c) column encryption through
    OpenBao Transit for sensitive fields only. Recommended: (b) for the whole store plus (c) for the few fields that
    carry secrets-adjacent data. REQ-SEC-011 waits on this; REQ-UI-021/022/023 wait on question 0 (native charts or
    Superset).
