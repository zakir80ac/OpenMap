# Deploying OpenMap

Three profiles ship in this directory. Every value they set mirrors a documented default in
`packages/config/src/env.ts`; nothing in application code carries a host, port or path.

| Profile | Where | Use |
| --- | --- | --- |
| Single node (compose) | `compose/docker-compose.yml` + `compose/docker-compose.apps.yml` | evaluation, labs, small estates (REQ-INT-001) |
| Air-gapped (compose) | the two files above + `compose/docker-compose.airgap.yml` and the offline bundle | sovereign sites with no egress (REQ-INT-002, REQ-INT-008) |
| Kubernetes (Helm) | `helm/openmap` | production clusters, OpenShift included (REQ-INT-003) |

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

## Air-gapped

Build or mirror the images on a connected machine, export them with `docker save`, carry the
bundle across, `docker load`, then start with the air-gap overlay, which pins `pull_policy: never`
and disables every optional egress (LLM model download, analytics):

```bash
docker compose -f docker-compose.yml -f docker-compose.apps.yml -f docker-compose.airgap.yml up -d
```

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
- **Enterprise SSO (SAML or OIDC brokering).** Add the corporate identity provider under *Identity Providers* (SAML
  2.0 or OpenID Connect) and give it two mappers: an *Attribute Importer* that writes the assertion's tenant
  attribute into the user attribute `tenant`, and a *Role Mapper* (or *Advanced Attribute to Role*) that grants the
  realm roles from the directory's groups. Set the provider as the realm's default with *Browser flow → Identity
  Provider Redirector* so users never see the Keycloak form. Nothing in the console or API changes: tokens still
  come from this realm.
- **MFA.** The realm pins the TOTP policy (6 digits, 30 s, one window of drift, no code reuse) and enables the
  *Configure OTP* required action; the default browser flow enforces the second factor for every user who has
  enrolled. To make it mandatory, set *Configure OTP* as a default action for new users or require it for the
  `openmap-admin` role with a conditional OTP sub-flow in the browser flow.
- **Brute force.** Progressive lockout is on: 10 failures, waits growing by 60 s up to 15 minutes, failures
  forgotten after 12 hours.
- **API tokens.** Automation uses the confidential `openmap-automation` client (client-credentials grant, service
  account with `openmap-operator`, hardcoded `tenant` claim, `aud: openmap-api`). Read the secret once from
  *Clients → openmap-automation → Credentials* and store it in OpenBao; create one such client per tenant. The flow
  and a request example are in `apps/api/README.md`.

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
   `/etc/openmap/agent` (`%ProgramData%\OpenMapgent` on Windows) or wherever `AGENT_MTLS_*_PATH` point.
4. `openmap-agent run` reports every `OPENMAP_AGENT_INTERVAL_MS` (default 15 minutes); `openmap-agent report` sends
   once; `openmap-agent collect` prints the observation without sending it.

Each report is a run of a standing `agent` job on that Node, so history, evidence (stored on the Node by digest) and
metrics appear in the console exactly like agentless discovery.
