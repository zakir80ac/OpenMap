# Deploying OpenMap

Three profiles ship in this directory. Every value they set mirrors a documented default in
`packages/config/src/env.ts`; nothing in application code carries a host, port or path.

| Profile               | Where                                                                            | Use                                                       |
| --------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Single node (compose) | `compose/docker-compose.yml` + `compose/docker-compose.apps.yml`                 | evaluation, labs, small estates (REQ-INT-001)             |
| Air-gapped (compose)  | the two files above + `compose/docker-compose.airgap.yml` and the offline bundle | sovereign sites with no egress (REQ-INT-002, REQ-INT-008) |
| Kubernetes (Helm)     | `helm/openmap`                                                                   | production clusters, OpenShift included (REQ-INT-003)     |

## Images

Two recipes build every image from the repository root:

```bash
docker build -f deploy/docker/node-service.Dockerfile --build-arg APP=api        -t openmap/api:dev .
docker build -f deploy/docker/node-service.Dockerfile --build-arg APP=scheduler  -t openmap/scheduler:dev .
docker build -f deploy/docker/node-service.Dockerfile --build-arg APP=reconciler -t openmap/reconciler:dev .
docker build -f deploy/docker/node-service.Dockerfile --build-arg APP=bsm-engine -t openmap/bsm-engine:dev .
docker build -f deploy/docker/node.Dockerfile -t openmap/node:dev .
```

`node-service.Dockerfile` compiles the pnpm workspace once and copies only the service, its
production dependencies and the workspace packages it imports (`pnpm deploy`). `node.Dockerfile`
produces the Discovery Node and all collector binaries, statically linked on a distroless base.

## Single node

```bash
cd deploy/compose
cp .env.example .env            # edit secrets
docker compose -f docker-compose.yml -f docker-compose.apps.yml up -d --build
```

`migrate` applies the Postgres, ClickHouse and Memgraph migrations and exits; the services start
after it. The scheduler creates its CA and server certificate on first start into the `scheduler-pki`
volume (idempotent, never overwritten).

### Enrolling a Discovery Node

1. Register the Node and get its one-time token:
   `docker compose exec scheduler node dist/node-register.js --tenant <tenant uuid> --site HQ --node node-hq-01`
2. Start the Node profile with that token:
   `OPENMAP_ENROL_TOKEN=<token> OPENMAP_NODE_ID=node-hq-01 OPENMAP_SITE_CODE=HQ docker compose --profile node run --rm node enrol`
   then `docker compose --profile node up -d node`.
3. Submit a job or run a sweep from the console (`Discovery → Run discovery`); for a quick check:
   `docker compose exec scheduler node dist/job-submit.js --tenant <tenant uuid> --node node-hq-01 --collector port_scan --target 10.0.0.0/24 --kind cidr`.

Nodes only ever connect outbound to the scheduler over mTLS; no inbound port is opened on a site.
The compose `node` profile trusts the scheduler during its first enrolment by reading the scheduler's
CA from the shared `scheduler-pki` volume (`OPENMAP_BOOTSTRAP_CA_PATH`). A Node at a remote site
receives `ca.crt` out of band instead and leaves that variable unset. The scheduler certificate names
`PUBLIC_SCHEDULER_URL`'s host plus every name in `SCHEDULER_TLS_EXTRA_SANS` (the compose service name
`scheduler` and `localhost` by default), so in-network and external Nodes both verify it.

## Air-gapped (REQ-INT-002, REQ-SEC-003)

On a connected machine, `deploy/airgap-bundle/build-bundle.sh <version> <out dir>` builds the six application images,
pulls the pinned datastore images and writes one directory: `openmap-images-<version>.tar.gz` (17 images), the three
compose files, the realm, init scripts, `.env.example`, `load-bundle.sh` and `SHA256SUMS`. Carry that directory across.

On the air-gapped host (Docker Engine with the compose plugin; BusyBox or GNU userland), create `.env` from
`.env.example`, set the three origins browsers will use — `PUBLIC_CONSOLE_URL`, `PUBLIC_API_URL`,
`PUBLIC_KEYCLOAK_URL` — and run:

```bash
./load-bundle.sh <version>
```

It verifies the checksums, `docker load`s the images and starts the stack with the air-gap overlay, which pins
`pull_policy: never` and disables every optional egress (LLM model download, Memgraph and Meilisearch telemetry). The
realm import takes the console's redirect URIs from `PUBLIC_CONSOLE_URL`, so sign-in works at the host's real name
without touching Keycloak. `docs/evidence/airgap/load-airgap.md` records a full load on a host whose new outbound
connections are dropped by iptables.

## Secrets: OpenBao in production (REQ-SEC-011, ADR-067)

OpenBao runs in server mode with Raft storage and auto-unseal. It holds every integration and discovery credential,
and the encryption keys the database will depend on, so treat it as tier 0.

- **First start.** `openbao-keys` generates the static seal key once (`openbao-unseal` volume); `openbao-init`
  initialises OpenBao, enables KV v2 at `OPENBAO_MOUNT` and Transit (`openmap-fields` key), writes the
  `openmap-services` and `openmap-backup` policies and issues AppRole ids into the `openbao-approle` and
  `openbao-approle-backup` volumes, which the services and the backup service mount read-only. Services log in with
  AppRole and never hold a root token.
- **Take offline now:** the seal key (`openbao-unseal/unseal.key`: without it the data cannot be unsealed) and
  `openbao-init/init.json` (five recovery keys, threshold three, and the initial root token). Delete `init.json` from
  the volume once both are stored apart; generate a root token from the recovery keys when one is needed
  (`bao operator generate-root`). Keep the seal key and the recovery keys away from the data volume and its backups.
- **HSM or KMS.** Replace the `seal "static"` block in `openbao/openbao.hcl` (Helm: `openbao.seal.config`) with a
  `seal "pkcs11"` or `seal "kmip"` block; migrating seals needs both old and new seals available.
- **Snapshots.** Every backup set includes a Raft snapshot (`openbao.snap`, the backup AppRole may take one and do
  nothing else). Restore it with the same seal key: `bao operator raft snapshot restore openbao.snap` with an
  operator token.
- **Monitoring.** Prometheus scrapes `/v1/sys/metrics`; a sealed OpenBao answers 503 there, so alert on
  `up{job="openbao"} == 0`.
- **Host-side tests and operators** export `OPENBAO_TOKEN`; nothing in the services reads it.
## Encrypted PostgreSQL (REQ-SEC-011, ADR-067)

PostgreSQL is Percona Server for PostgreSQL 17 with pg_tde:

- Every table is `tde_heap` (the catalogs are not; pg_tde leaves them alone), and the WAL is encrypted.
- The principal key lives in OpenBao's `tde` mount, under a name made at first start
  (`openmap-principal-<UTC time>`).
- `pgtde-agent` (a sidecar on Helm) logs in with the `pg-tde` AppRole and keeps the token file pg_tde reads.
- The data directory is `/data/db` on the `postgres-tde-data` volume.

**Operating it:**

- **Without OpenBao, PostgreSQL does not start.** It needs OpenBao unsealed and the agent's token to load its key.
  Losing the `tde` mount (restore it from the OpenBao snapshot in every backup set) loses the database.
- **After revoking the agent's token, restart `pgtde-agent`.** The agent notices a revocation only at its next
  renewal. Until then PostgreSQL keeps working on the keys it holds, but cannot create or rotate a key, and cannot
  start. pg_tde reads the file on every call, so PostgreSQL needs no restart afterwards.
- **Rotating the principal key:**
  ```sql
  SELECT pg_tde_create_key_using_global_key_provider('<new name>', 'openbao');
  SELECT pg_tde_set_default_key_using_global_key_provider('<new name>', 'openbao');
  SELECT pg_tde_set_server_key_using_global_key_provider('<new name>', 'openbao');
  ```
  No restart is needed.
- **Helm:** `postgres.tde.enabled` (default true) takes effect when the data directory is first initialised. With
  `openbao.external`, set `postgres.tde.externalApproleSecret` (a Secret with `role-id` and `secret-id` of an AppRole on
  the pg-tde policy; the vault needs a KV v2 mount `tde`).

**Encryption in transit** (ADR-068). The internal services CA is OpenBao's PKI engine (`pki`, root "OpenMap
Internal Services CA"). It issues 30-day server certificates for the store names only, and the agent beside each
store renews them. Clients verify the server against `services-ca.crt`, a bundle of that CA and the CA of OpenBao's
own listener certificate (compose: the `service-ca` volume; Helm: each pod builds it at start). In the Node services
`loadEnv()` adds the bundle (`SERVICE_CA_PATH`) to the default trust, so fetch, ioredis and neo4j-driver verify against
it. Every store refuses plain connections:

| Store | Protocol | Certificate kept by | A renewed certificate is taken |
| --- | --- | --- | --- |
| PostgreSQL | `hostssl` only, TLS 1.2+ | `pgtde-agent` | SIGHUP to the postmaster |
| ClickHouse | HTTPS 8443, secure native 9440 | `clickhouse-keys` | ClickHouse reloads the file |
| Valkey | `rediss://`, plain port closed | `valkey-certs` | `CONFIG SET` to a new file, no restart (`valkey/with-tls.sh`) |
| Meilisearch | HTTPS | `meili-certs` | restart, seconds (`tls/restart-on-renewal.sh`) |
| Memgraph | `bolt+s://` | `memgraph-certs` | restart, minutes; so its certificate lasts `MEMGRAPH_TLS_TTL` (a year) |
| OpenBao | HTTPS | compose: `openbao-certs`; Helm: the chart | compose: SIGHUP; Helm: the pod rolls when the chart renews it |

- **OpenBao's first certificate.** OpenBao cannot issue its own before it runs. On compose, `openbao-keys` makes a
  bootstrap pair once with `bao server -dev -dev-tls` (its CA key is never written), and `openbao-certs` replaces it with
  one from the internal CA as soon as OpenBao is up. On Helm the chart generates the pair (`openbao.tls.days`, default
  730) into the Secret `<release>-openbao-tls`, and makes a new one on the first upgrade within `openbao.tls.renewDays`.
- **Agents and restarts.** An agent that restarts reuses the valid certificate it finds; only expiry, or a deleted
  file, makes it issue a new one.
- **Host-side tools:** they need `.local/services-ca.crt` (export the bundle again after this change: it now holds two
  certificates), the TLS addresses and the quoted `POSTGRES_URL` from `.env.example`, and, on Docker Desktop, the small
  pool it sets. Bursts of new connections through its port forwarding are dropped, and its `::1` forward can stop
  answering: `NODE_OPTIONS=--dns-result-order=ipv4first`.

**Moving a running install to TLS for Valkey, Memgraph, Meilisearch and OpenBao.** pg_tde keeps OpenBao's address in
the database. With the old address, PostgreSQL does not start once OpenBao serves TLS only ("returned invalid response
400"). Its online change checks the new address against OpenBao, which the old container cannot do (it has no CA
mounted), so the address is changed with PostgreSQL stopped, and once more online so that the change is in the WAL
(tried on a scratch stack: wrong address, refusal to start, recovery):

1. Stop the services that write: `docker compose ... stop api scheduler reconciler bsm-engine node console`.
2. Take a backup set: `docker compose ... --profile backup run --rm backup create pre-tls`.
3. Stop PostgreSQL: `docker compose ... stop postgres`.
4. Bring up OpenBao on TLS, its agent, and the stores: `docker compose ... up -d --no-deps openbao-keys openbao
   openbao-init openbao-certs pgtde-agent clickhouse-keys clickhouse valkey-certs memgraph-certs meili-certs valkey
   memgraph meilisearch`.
5. Change pg_tde's provider offline: `docker compose ... run --rm --no-deps --entrypoint pg_tde_change_key_provider
   postgres -D /data/db 1664 openbao vault-v2 https://openbao:8200 tde /run/pgtde/token
   /run/openmap/ca/services-ca.crt` ("Key provider updated successfully!").
6. Start everything: `docker compose ... up -d`.
7. Record the change in the WAL: `SELECT pg_tde_change_global_key_provider_vault_v2('openbao', 'https://openbao:8200',
   'tde', '/run/pgtde/token', '/run/openmap/ca/services-ca.crt');`
8. Export the bundle for host-side tools again (`.local/services-ca.crt`) and set the TLS addresses in `.env`.

**Encrypted ClickHouse** (ADR-067 step 6):

- **What is encrypted:** ClickHouse stores every data part, system logs included, on an `encrypted` disk (AES-256-CTR)
  over `/var/lib/clickhouse/disks/sealed`; that is the default storage policy. Table metadata (the DDL) stays plain.
- **The key:** generated once by `openbao-init` into `tde/clickhouse-disk`. `clickhouse-keys` (OpenBao Agent, AppRole
  `clickhouse-disk`; a sidecar on Helm) renders it into a memory volume.
- **Start-up:** `clickhouse/with-disk-key.sh` waits for the key and starts the server with it. Without it, ClickHouse
  does not start.
- **Volumes:** data is on `clickhouse-tde-data`. An install from before kept plain parts in `clickhouse-data`; move it
  as PostgreSQL was moved (stop the writers, `backup create`, recreate ClickHouse, then
  `backup restore <set> --clickhouse-only`).
- **Helm:** `clickhouse.encryption.enabled` (default true) takes effect on an empty volume. With `openbao.external`,
  set `clickhouse.encryption.externalApproleSecret`.

**Field encryption** (ADR-067 step 4). Some personal data is also encrypted inside the database:

- the fields: vendor contacts (name, email, phone), asset custodians and their audit entries, and custom fields
  created as *sensitive*;
- the key: Transit key `openmap-fields`; values are stored as `vault:v<n>:…` ciphertext and decrypted only by the API;
- the protection: anyone who can query the database, and `pg_dump` output, see only ciphertext;
- the cost: those fields cannot be searched, filtered or sorted in the database.

Values written before field encryption stay readable. Encrypt them once with
`docker compose ... run --rm reconciler node dist/encrypt-fields.js [--tenant <id>]`; it can be run again safely.

**Moving an install that ran stock PostgreSQL** (its data is in the `postgres-data` volume; measured on the dev stack:
9.4 GB of PostgreSQL restored in 1.6 min):

1. Stop the services that write: `docker compose ... stop api scheduler reconciler bsm-engine node console superset
   keycloak`.
2. Take a set from the running stock server, before compose sees the new definition:
   `docker compose ... --profile backup run --rm --no-deps backup create pre-tde`.
3. Remove the old container (`docker rm -f openmap-postgres-1`). The `postgres-data` volume stays, as the way back.
4. Start the new one: `docker compose ... up -d postgres`. It starts `pgtde-agent` first and creates the key.
5. Restore PostgreSQL only: `docker compose ... --profile backup run --rm --no-deps backup restore pre-tde
   --postgres-only`. Tables take `tde_heap`, the target's default.
6. Check: `SELECT count(*) FILTER (WHERE pg_tde_is_encrypted(c.oid)), count(*) FROM pg_class c JOIN pg_namespace n
   ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname IN ('public', 'keycloak', 'superset')`. The two
   counts are equal.
7. `docker compose ... up -d`. Memgraph, ClickHouse and Meilisearch are untouched.
8. Once the stack has run on it, remove `postgres-data`: it holds the data unencrypted.

## VM appliance (REQ-INT-018)

`deploy/appliance` builds an Ubuntu Server 24.04 VM image that runs OpenMap with no network access.

**Building the image** (on a connected Linux machine with KVM):

1. Build the air-gap bundle: `deploy/airgap-bundle/build-bundle.sh <version> <dir>`.
2. Build the image:
   `packer init deploy/appliance && packer build -var openmap_version=<version> -var bundle_dir=<dir> -var build_password=<random> deploy/appliance`.
   This produces `openmap-<version>.qcow2`, plus `.vmdk` (VMware, for an OVA) and `.vhdx` (Hyper-V).

The image carries Docker, every image already loaded, and two units:

- **`openmap-firstboot.service`** runs once, before the first start. It gives this VM its own random passwords and keys
  in `/opt/openmap/.env` (mode 0600) and sets the public URLs to the VM's address (or `OPENMAP_PUBLIC_HOST`). It writes
  the generated administrator credentials to `/root/openmap-credentials.txt`: store them and delete the file.
- **`openmap.service`** starts the air-gapped compose stack on every boot.

The build user is locked before the image is sealed.

## Backup and restore (REQ-INT-019, ADR-066)

A backup set holds the stores of record: PostgreSQL (`pg_dump` custom archive: application, Keycloak and Superset
schemas) and ClickHouse (native `BACKUP`), with a manifest of sizes, checksums, the schema migration and the CI count.
Memgraph and Meilisearch are rebuilt from PostgreSQL after a restore. Sets live on the `backups` volume; put it on
separate storage.

**Sets are encrypted** (REQ-SEC-011, ADR-067 step 5):

- **How:** each set gets a fresh data key from OpenBao Transit (key `openmap-backup`), and only the wrapped key is
  written to the manifest. The PostgreSQL archive and a tar of the ClickHouse backup are encrypted with AES-256-CTR and
  authenticated with HMAC-SHA256 (`postgres.dump.enc`, `clickhouse.tar.enc`).
- **What `verify` checks:** the MACs, before anything reads the plaintext.
- **What `restore` does:** decrypts beside the set and removes the plaintext afterwards.
- **Restoring needs OpenBao.** A set restores only where OpenBao holds `openmap-backup`: restore OpenBao from a
  set's `openbao.snap` first.
- **The OpenBao snapshot is left as OpenBao wrote it.** It is already encrypted by OpenBao with the seal key, so keep
  the seal key and recovery keys apart from the sets.
- **Without OpenBao,** `create` refuses to write a set. `BACKUP_ENCRYPTION=off` writes plaintext sets, for an install
  without OpenBao only.
- **Older plaintext sets** still verify and restore.

Take a backup (on demand, or from the host's cron / systemd timer once a day; the newest `BACKUP_KEEP` sets are kept):

```
docker compose -f docker-compose.yml -f docker-compose.apps.yml --profile backup run --rm backup create
docker compose -f docker-compose.yml -f docker-compose.apps.yml --profile backup run --rm backup list
docker compose -f docker-compose.yml -f docker-compose.apps.yml --profile backup run --rm backup verify <set>
```

Restore a set:

1. Stop the writers: `docker compose ... stop api scheduler reconciler bsm-engine`.
2. `docker compose ... --profile backup run --rm backup restore <set>` (it verifies the set first).
3. Rebuild the projections: `docker compose ... run --rm migrate node dist/reproject.js`.
4. Start the writers again; the BSM engine recomputes service health on its next tick.

A restore drill into other databases leaves the live ones untouched:
`backup restore <set> --postgres-url postgresql://…/openmap_drill --clickhouse-db openmap_drill` (create the drill
PostgreSQL database first). The Settings screen shows administrators whether the newest complete set is younger than
26 hours, and Prometheus reads `openmap_backup_last_complete_timestamp_seconds`. On Kubernetes, run the
`openmap/backup` image as a CronJob with the same environment.

## Platform health and SLO alerts (REQ-PERF-005, ADR-071)

The stack watches itself with its own Prometheus; nothing leaves the deployment, so this works unchanged in the
air-gapped profile.

- **Alert rules.** `prometheus/rules/openmap-slo.rules.yml` is generated from `packages/telemetry/src/slo.ts`
  (`pnpm --filter @openmap/telemetry build && pnpm --filter @openmap/telemetry slo:rules`) and loaded through
  `rule_files` in `prometheus/prometheus.yml`. After changing either, restart Prometheus:
  `docker compose -f docker-compose.yml restart prometheus`. Check the rules with
  `docker compose exec prometheus promtool check rules /etc/prometheus/rules/openmap-slo.rules.yml`.
- **Stores and backlogs.** The reconciler's `/metrics` probes PostgreSQL, Memgraph, ClickHouse, Valkey and Meilisearch
  at every scrape (`openmap_store_up`), and reports the outbox backlog and the BullMQ queue depths.
- **The screen.** Administrators open **Platform health** (beside Settings): the SLO indicators against their
  objectives, firing alerts, every scrape target with its request rate, p95, 5xx share, event-loop delay, memory and
  CPU, the stores, the backlogs and the perf budget results. The API reads Prometheus at `PROMETHEUS_URL` and the
  results under `PERF_RESULTS_DIR`, mounted read-only from `PERF_RESULTS_HOST_DIR` (default `tools/perf/results`; the
  air-gap bundle ships an empty `perf-results/` for them).

## Kubernetes

The chart has no subchart dependencies, so it installs from a mirrored registry without network
access. Datastores run as in-chart StatefulSets; point `openbao.external` at an existing vault in
production and set `image.registry` to the mirror.

```bash
helm upgrade --install openmap deploy/helm/openmap \
  --namespace openmap --create-namespace \
  --set image.registry=registry.example.internal \
  --set api.publicUrl=https://openmap.example.internal \
  --set console.publicUrl=https://openmap.example.internal \
  --set keycloak.publicUrl=https://auth.example.internal \
  --set scheduler.publicHost=scheduler.example.internal
```

Migrations run as a `pre-install,pre-upgrade` hook. The scheduler is a StatefulSet with two
volumes: the discovery PKI and the evidence store. Discovery Nodes run outside the cluster, at the
sites they observe, from the `openmap/node` image or the bare binary.

## Identity: SSO, MFA and API tokens (REQ-SEC-009)

The realm export `compose/keycloak/realm-openmap.json` is the source of truth for identity policy and is imported on
first start (Keycloak ignores it once the realm exists; apply later changes through the admin console or the admin
REST API, see `docs/STATE.md`).

- **Console sign-in** is OIDC Authorization Code with PKCE through the public `openmap-console` client; the API
  verifies the issuer against `PUBLIC_KEYCLOAK_URL` and the audience against `KEYCLOAK_CLIENT_ID` / `KEYCLOAK_API_CLIENT_ID`.
- **Roles** are realm roles (`openmap-admin ⊇ operator ⊇ analyst`, `auditor ⊇ analyst`); the `tenant` user attribute
  scopes every request. Map both from your directory when brokering.
- **Enterprise SSO (SAML or OIDC brokering).** Add the corporate identity provider under _Identity Providers_ (SAML
  2.0 or OpenID Connect) and give it two mappers: an _Attribute Importer_ that writes the assertion's tenant
  attribute into the user attribute `tenant`, and a _Role Mapper_ (or _Advanced Attribute to Role_) that grants the
  realm roles from the directory's groups. Set the provider as the realm's default with _Browser flow → Identity
  Provider Redirector_ so users never see the Keycloak form. Nothing in the console or API changes: tokens still
  come from this realm.
- **Identity sources from OpenMap (REQ-INT-016, ADR-074).** Administrators add Active Directory / LDAP directories
  and Entra ID, Okta or other OpenID Connect providers on _Settings → Identity sources_; the API applies each one to
  the realm (`IDENTITY_FEDERATION_REALM`, default `KEYCLOAK_REALM`) with the tenant attribute and group-to-role
  mappings above already in place. Store the bind password (`password`) or client secret (`clientSecret`, e.g. a
  Setup `oauth_client` credential set) in OpenBao and give its path; register the redirect URI the card shows with the
  provider. The API signs in to Keycloak's admin API with `KEYCLOAK_ADMIN_CLIENT_ID` / `KEYCLOAK_ADMIN_CLIENT_SECRET`
  in `KEYCLOAK_ADMIN_REALM` (production: a service-account client with the realm-management roles `manage-realm`,
  `manage-users`, `view-realm`), or with the bootstrap administrator `KEYCLOAK_ADMIN` when no secret is set. Entra ID
  authorities other than the public cloud go in `IDENTITY_ENTRA_AUTHORITY_URL`. The airgap profile refuses Entra ID
  and Okta (internet services); directories and self-hosted providers work there.
- **MFA.** The realm pins the TOTP policy (6 digits, 30 s, one window of drift, no code reuse) and enables the
  _Configure OTP_ required action; the default browser flow enforces the second factor for every user who has
  enrolled. To make it mandatory, set _Configure OTP_ as a default action for new users or require it for the
  `openmap-admin` role with a conditional OTP sub-flow in the browser flow.
- **Brute force.** Progressive lockout is on: 10 failures, waits growing by 60 s up to 15 minutes, failures
  forgotten after 12 hours.
- **API tokens.** Automation uses the confidential `openmap-automation` client (client-credentials grant, service
  account with `openmap-operator`, `aud: openmap-api`). The `tenant` claim comes from the service-account user's
  `tenant` attribute (_Clients → openmap-automation → Service account roles → user_, attribute `tenant`), exactly like
  an interactive user, so one client serves one tenant. Read the secret once from _Clients → openmap-automation →
  Credentials_ and store it in OpenBao; create one such client per tenant. The flow and a request example are in
  `apps/api/README.md`.

## Analytics and the assistant (REQ-UI-017, REQ-UI-018, REQ-INT-004)

**Analytics.** The API provisions the "OpenMap estate analytics" dashboard in Superset on first use of the Analytics
screen: a ClickHouse database connection (from `CLICKHOUSE_URL`/`CLICKHOUSE_DB`), five datasets over the warehouse
tables, five charts, the dashboard layout, the embedded-dashboard id and the `OpenMapEmbedded` guest role with Gamma's
permissions. Each request then mints a five-minute guest token whose row-level-security clause pins `tenant_id`, and
the console embeds the dashboard with Superset's embedded SDK from `PUBLIC_SUPERSET_URL` (the origin browsers reach;
`SUPERSET_URL` is the backchannel). Superset credentials come from `SUPERSET_ADMIN_USER`/`SUPERSET_ADMIN_PASSWORD`;
`superset_config.py` enables `EMBEDDED_SUPERSET`, `ROW_LEVEL_SECURITY` and the security API the provisioner uses.

**Assistant.** `askAssistant` needs an OpenAI-compatible chat endpoint at `LLM_BASE_URL`. The compose stack ships two
profiles: `gpu` (vLLM, `LLM_MODEL`) and `cpu` (llama.cpp server, `LLM_GGUF` under `LLM_MODELS_DIR`). The defaults in
`.env.example` name a small coder model for laptops; put the GGUF in `./models` and start the profile:

```bash
docker compose -f docker-compose.yml -f docker-compose.apps.yml --profile cpu up -d llm-cpu
```

The generated Cypher is validated read-only and shown with every answer; a model that produces an invalid query gets
an explicit refusal in the console rather than a wrong answer.

## Host agents (REQ-DISC-004)

`openmap-agent` is a static binary for Linux, Windows and macOS (built from `apps/collectors/cmd/agent`, shipped in
the Node image under `/opt/openmap/collectors/agent`). It reports the host's own inventory (identity, OS, addresses,
listening services with their processes, installed software) through its site's Discovery Node; agents never talk to
the scheduler.

1. On the Node, enable the gateway: `OPENMAP_AGENT_LISTEN_ADDR=:4300` (compose `node` profile does this). The gateway
   serves the Node's own mTLS certificate, so agents must reach the Node under its node id (the compose network alias)
   or a name the certificate carries.
2. Register the agent and get its one-time token:
   `pnpm --filter @openmap/scheduler agent:register -- --node <nodeId> --agent <host fqdn>`.
3. On the host: `OPENMAP_AGENT_NODE_URL=https://<node>:4300 OPENMAP_AGENT_ID=<host fqdn> OPENMAP_ENROL_TOKEN=<token>
OPENMAP_BOOTSTRAP_CA_PATH=<discovery ca.crt> openmap-agent enrol`. The certificate and key land under
   `/etc/openmap/agent` (`%ProgramData%\OpenMap\agent` on Windows) or wherever `AGENT_MTLS_*_PATH` point.
4. `openmap-agent run` reports every `OPENMAP_AGENT_INTERVAL_MS` (default 15 minutes); `openmap-agent report` sends
   once; `openmap-agent collect` prints the observation without sending it.

Each report is a run of a standing `agent` job on that Node, so history, evidence (stored on the Node by digest) and
metrics appear in the console exactly like agentless discovery.

## Installing the Node and the agent as services (REQ-DISC-031, REQ-DISC-004)

Both binaries run as native services on bare metal; `deploy/install/` holds the units and installers. Each binary
reads an environment file at start (`OPENMAP_NODE_ENV_FILE`, default `/etc/openmap/node.env`; `OPENMAP_AGENT_ENV_FILE`,
default `agent.env` next to the agent's PKI directory) so the units carry no site-specific values, and a binary started
with no arguments under the Windows service control manager hosts itself as a service.

| Platform        | Node                                       | Agent                                          |
| --------------- | ------------------------------------------ | ---------------------------------------------- |
| Linux (systemd) | `install-node.sh` + `openmap-node.service` | `install-agent.sh` + `openmap-agent.service`   |
| macOS (launchd) | run under compose or Kubernetes            | `install-agent.sh` + `com.openmap.agent.plist` |
| Windows         | `install-node.ps1` (service `OpenMapNode`) | `install-agent.ps1` (service `OpenMapAgent`)   |

`deploy/install/build-release.sh <version> [out] [os/arch …]` builds the release: one tarball per target (Linux
amd64/arm64, Windows amd64, macOS arm64/amd64) holding `bin/openmap-node`, `bin/openmap-agent`, every collector under
`collectors/`, the `install/` scripts and units, `VERSION` and `SHA256SUMS`, plus a `SHA256SUMS-<version>` over the
tarballs. Unpack one and run the installer as root or from an elevated PowerShell with the one-time token from
`node-register` / `agent:register`:

```bash
sudo install/install-node.sh --node node-ryd-02 --site RYD --scheduler https://scheduler.example:4200 --token <token> --ca ca.crt
sudo install/install-agent.sh --node-url https://node-ryd-02.example:4300 --token <token> --ca ca.crt
```

```powershell
.\install\install-node.ps1 -NodeId node-ryd-02 -SiteCode RYD -SchedulerUrl https://scheduler.example:4200 -Token <token> -Ca .\ca.crt
.\install\install-agent.ps1 -NodeUrl https://node-ryd-02.example:4300 -Token <token> -Ca .\ca.crt
```

The installers copy the binaries (`/opt/openmap/bin`, `%ProgramFiles%\OpenMap`), write the environment file with
restricted permissions (`/etc/openmap`, `%ProgramData%\OpenMap`), enrol once with the token (which is never stored),
then enable and start the service with automatic restart. The Linux Node runs as the unprivileged `openmap` user with
`CAP_NET_RAW` only; the agent runs as root/SYSTEM because it reads every process's sockets and the package database.
Re-running an installer upgrades the binary and recreates the service without re-enrolling if the certificate already
exists. Logs: `journalctl -u openmap-node`, `/var/log/openmap-agent.log` on macOS, the Application event log on Windows.
