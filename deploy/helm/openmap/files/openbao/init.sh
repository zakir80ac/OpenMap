#!/bin/sh
# REQ-SEC-011 (ADR-067) — brings a production OpenBao to the state OpenMap needs, idempotently:
#   1. initialise once (auto-unseal: recovery keys, not unseal keys) and keep the output in /openbao/init (mode 0600);
#      move the recovery keys and the initial root token offline and delete the file once the deployment is settled;
#   2. KV v2 at $OPENBAO_MOUNT, Transit with the openmap-fields key;
#   3. the openmap-services and openmap-backup policies and their AppRoles;
#   4. role id and secret id files for the services (/openbao/approle) and the backup service (/openbao/approle-backup),
#      readable by the user the services run as ($SERVICE_UID); or, when SERVICES_ROLE_ID / SERVICES_SECRET_ID /
#      BACKUP_ROLE_ID / BACKUP_SECRET_ID are given (Helm generates them into a Secret), those ids are registered;
#   5. the pg-tde policy and AppRole for the OpenBao Agent beside a pg_tde PostgreSQL (its principal keys, `tde` mount);
#   6. ClickHouse's encrypted disk key (`tde/clickhouse-disk`), and the clickhouse-disk policy and AppRole that read it;
#   7. (ADR-068) the internal services CA, and the store-tls policy and AppRole of the agents that keep the server
#      certificates of Valkey, Memgraph and Meilisearch.
set -eu
export BAO_ADDR="${BAO_ADDR:-https://openbao:8200}"
# ADR-068: OpenBao serves TLS only; the bundle on the service-ca volume (seeded by openbao-keys) verifies it.
export BAO_CACERT="${BAO_CACERT:-/openbao/service-ca/services-ca.crt}"
MOUNT="${OPENBAO_MOUNT:-openmap}"
SERVICE_UID="${SERVICE_UID:-1000}"
INIT=/openbao/init/init.json

log() { printf '{"msg":"%s"}\n' "$1"; }

# bao status exits 0 unsealed, 2 sealed (or not initialised), 1 on error.
tries=0
until bao status > /dev/null 2>&1 || [ $? -eq 2 ]; do
  tries=$((tries + 1))
  [ "$tries" -gt 60 ] && { log "openbao did not answer"; exit 1; }
  sleep 1
done

if bao status -format=json | grep -q '"initialized": false'; then
  umask 077
  bao operator init -recovery-shares=5 -recovery-threshold=3 -format=json > "$INIT"
  log "initialised; move the recovery keys and the root token in /openbao/init/init.json offline"
fi
[ -s "$INIT" ] || { log "openbao is initialised but $INIT is missing: run this job with an operator token in BAO_TOKEN"; [ -n "${BAO_TOKEN:-}" ] || exit 1; }
if [ -z "${BAO_TOKEN:-}" ]; then
  BAO_TOKEN=$(sed -n 's/.*"root_token": *"\([^"]*\)".*/\1/p' "$INIT" | head -n 1)
  export BAO_TOKEN
fi

tries=0
until bao status -format=json | grep -q '"sealed": false'; do
  tries=$((tries + 1))
  [ "$tries" -gt 60 ] && { log "openbao stayed sealed: check the seal key"; exit 1; }
  sleep 1
done

mounts=$(bao secrets list -format=json)
printf '%s' "$mounts" | grep -q "\"$MOUNT/\"" || bao secrets enable -path="$MOUNT" -version=2 kv
printf '%s' "$mounts" | grep -q '"transit/"' || bao secrets enable transit
bao read transit/keys/openmap-fields > /dev/null 2>&1 || bao write -f transit/keys/openmap-fields type=aes256-gcm96 > /dev/null
# The key that wraps each backup set's data key (ADR-067 step 5).
bao read transit/keys/openmap-backup > /dev/null 2>&1 || bao write -f transit/keys/openmap-backup type=aes256-gcm96 > /dev/null
# pg_tde's principal keys live in their own KV v2 mount, apart from the credentials.
printf '%s' "$mounts" | grep -q '"tde/"' || bao secrets enable -path=tde -version=2 kv
# ClickHouse's encrypted disk key (ADR-067 step 6): 256 bits, generated once; never rotated by this job.
bao kv get tde/clickhouse-disk > /dev/null 2>&1 || bao kv put tde/clickhouse-disk key="$(od -An -N32 -tx1 /dev/urandom | tr -d ' 
')" > /dev/null

# ADR-068: the internal services CA. A root in the PKI engine (its key never leaves OpenBao), a role that issues
# server certificates for the store names only (30 days unless a template asks for longer, up to SERVICE_TLS_MAX_TTL:
# Memgraph's lasts a year, because taking a new one restarts it), and the CA certificate on the public service-ca volume.
SERVICE_TLS_MAX_TTL="${SERVICE_TLS_MAX_TTL:-8760h}"
SERVICE_TLS_NAMES="${SERVICE_TLS_NAMES:-postgres,clickhouse,memgraph,valkey,meilisearch,openbao,localhost}"
if ! printf '%s' "$mounts" | grep -q '"pki/"'; then
  bao secrets enable pki > /dev/null
  bao secrets tune -max-lease-ttl=87600h pki > /dev/null
fi
bao read -field=certificate pki/cert/ca > /dev/null 2>&1 ||
  bao write -field=certificate pki/root/generate/internal common_name="OpenMap Internal Services CA" ttl=87600h key_type=ec key_bits=256 > /dev/null
bao write pki/roles/openmap-services allowed_domains="$SERVICE_TLS_NAMES" allow_bare_domains=true allow_subdomains=false   allow_localhost=true allow_ip_sans=true server_flag=true client_flag=false key_type=ec key_bits=256 ttl=720h max_ttl="$SERVICE_TLS_MAX_TTL" > /dev/null
# The bundle every client trusts: the internal CA, and the CA of OpenBao's bootstrap certificate (openbao-keys), which
# OpenBao serves until its agent first renews it. Written to a new file and renamed, so no client reads half of it.
if [ -d /openbao/service-ca ]; then
  bundle=/openbao/service-ca/services-ca.crt
  bao read -field=certificate pki/cert/ca > "$bundle.tmp"
  echo >> "$bundle.tmp"
  [ -s /openbao/service-ca/openbao-bootstrap-ca.crt ] && cat /openbao/service-ca/openbao-bootstrap-ca.crt >> "$bundle.tmp"
  chmod 0444 "$bundle.tmp"
  mv -f "$bundle.tmp" "$bundle"
fi

# The policy file names the default mount; it is written for the mount this deployment uses.
sed "s#^path \"openmap/#path \"$MOUNT/#" /openbao/policies/openmap-services.hcl | bao policy write openmap-services - > /dev/null
bao policy write openmap-backup /openbao/policies/openmap-backup.hcl > /dev/null
bao policy write pg-tde /openbao/policies/pg-tde.hcl > /dev/null
bao policy write clickhouse-disk /openbao/policies/clickhouse-disk.hcl > /dev/null
bao policy write store-tls /openbao/policies/store-tls.hcl > /dev/null
bao auth list -format=json | grep -q '"approle/"' || bao auth enable approle
bao write auth/approle/role/openmap-services token_policies=openmap-services token_ttl=1h token_max_ttl=4h secret_id_ttl=0 secret_id_num_uses=0 > /dev/null
bao write auth/approle/role/openmap-backup token_policies=openmap-backup token_ttl=15m token_max_ttl=1h secret_id_ttl=0 secret_id_num_uses=0 > /dev/null
bao write auth/approle/role/pg-tde token_policies=pg-tde token_ttl=1h token_max_ttl=24h secret_id_ttl=0 secret_id_num_uses=0 > /dev/null
bao write auth/approle/role/clickhouse-disk token_policies=clickhouse-disk token_ttl=1h token_max_ttl=24h secret_id_ttl=0 secret_id_num_uses=0 > /dev/null
bao write auth/approle/role/store-tls token_policies=store-tls token_ttl=1h token_max_ttl=24h secret_id_ttl=0 secret_id_num_uses=0 > /dev/null

register() {
  # $1 role, $2 role id, $3 secret id: ids an orchestrator generated (Helm keeps them in a Secret the services mount).
  bao write "auth/approle/role/$1/role-id" role_id="$2" > /dev/null
  bao write "auth/approle/role/$1/secret-id/lookup" secret_id="$3" > /dev/null 2>&1 ||
    bao write "auth/approle/role/$1/custom-secret-id" secret_id="$3" > /dev/null
}

issue() {
  # $1 role, $2 directory, $3 owner uid (default SERVICE_UID): role id always (it is stable), a secret id only when
  # none was issued yet.
  mkdir -p "$2"
  bao read -field=role_id "auth/approle/role/$1/role-id" > "$2/role-id"
  [ -s "$2/secret-id" ] || bao write -f -field=secret_id "auth/approle/role/$1/secret-id" > "$2/secret-id"
  chown "${3:-$SERVICE_UID}" "$2" "$2/role-id" "$2/secret-id"
  chmod 0500 "$2"
  chmod 0400 "$2/role-id" "$2/secret-id"
}
if [ -n "${SERVICES_ROLE_ID:-}" ]; then
  register openmap-services "$SERVICES_ROLE_ID" "${SERVICES_SECRET_ID:?SERVICES_SECRET_ID is required with SERVICES_ROLE_ID}"
  register openmap-backup "${BACKUP_ROLE_ID:?BACKUP_ROLE_ID is required}" "${BACKUP_SECRET_ID:?BACKUP_SECRET_ID is required}"
  if [ -n "${PGTDE_ROLE_ID:-}" ]; then
    register pg-tde "$PGTDE_ROLE_ID" "${PGTDE_SECRET_ID:?PGTDE_SECRET_ID is required with PGTDE_ROLE_ID}"
  fi
  if [ -n "${CLICKHOUSE_ROLE_ID:-}" ]; then
    register clickhouse-disk "$CLICKHOUSE_ROLE_ID" "${CLICKHOUSE_SECRET_ID:?CLICKHOUSE_SECRET_ID is required with CLICKHOUSE_ROLE_ID}"
  fi
  if [ -n "${STORES_ROLE_ID:-}" ]; then
    register store-tls "$STORES_ROLE_ID" "${STORES_SECRET_ID:?STORES_SECRET_ID is required with STORES_ROLE_ID}"
  fi
else
  issue openmap-services /openbao/approle
  issue openmap-backup /openbao/approle-backup
  # The agent beside PostgreSQL reads these as its own user.
  issue pg-tde /openbao/approle-pgtde "${PGTDE_AGENT_UID:-26}"
  # The agent beside ClickHouse runs as the ClickHouse image's user (uid 101).
  issue clickhouse-disk /openbao/approle-clickhouse "${CLICKHOUSE_AGENT_UID:-101}"
  # The agents beside Valkey, Memgraph and Meilisearch run as their stores' users; one secret id each.
  issue store-tls /openbao/approle-valkey "${VALKEY_AGENT_UID:-999}"
  issue store-tls /openbao/approle-memgraph "${MEMGRAPH_AGENT_UID:-101}"
  issue store-tls /openbao/approle-meili "${MEILI_AGENT_UID:-100}"
  # The agent that keeps OpenBao's own listener certificate runs as OpenBao's user.
  issue store-tls /openbao/approle-openbao "${OPENBAO_AGENT_UID:-100}"
fi
log "openbao ready"
