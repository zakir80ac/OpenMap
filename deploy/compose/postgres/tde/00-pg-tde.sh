#!/bin/sh
# REQ-SEC-011 (ADR-067) — first start of Percona PostgreSQL with pg_tde (runs once, from docker-entrypoint-initdb.d,
# before the schemas are created): the extension in template1 and the application database, OpenBao's KV v2 mount `tde`
# as the global key provider (its token file is kept fresh by the OpenBao Agent beside PostgreSQL), one principal key
# as every database's default and as the server key for the WAL, WAL encryption, and tde_heap as the default table
# access method. The settings that need a restart take effect when the entrypoint starts the final server.
set -eu
: "${OPENBAO_ADDR:?OPENBAO_ADDR is required}"
TOKEN_FILE="${PG_TDE_TOKEN_FILE:-/run/pgtde/token}"
KEY="${PG_TDE_KEY_NAME:-openmap-principal-1}"
PROVIDER="${PG_TDE_PROVIDER:-openbao}"
MOUNT="${PG_TDE_MOUNT:-tde}"

tries=0
until [ -s "$TOKEN_FILE" ]; do
  tries=$((tries + 1))
  [ "$tries" -gt 60 ] && { echo "pg_tde: no OpenBao token at $TOKEN_FILE" >&2; exit 1; }
  sleep 1
done

psql=" psql -v ON_ERROR_STOP=1 --username $POSTGRES_USER --no-password"
for db in template1 "$POSTGRES_DB"; do
  $psql --dbname "$db" -c 'CREATE EXTENSION IF NOT EXISTS pg_tde;'
done
$psql --dbname "$POSTGRES_DB" <<SQL
SELECT pg_tde_add_global_key_provider_vault_v2('$PROVIDER', '$OPENBAO_ADDR', '$MOUNT', '$TOKEN_FILE', NULL);
SELECT pg_tde_create_key_using_global_key_provider('$KEY', '$PROVIDER');
SELECT pg_tde_set_default_key_using_global_key_provider('$KEY', '$PROVIDER');
SELECT pg_tde_set_server_key_using_global_key_provider('$KEY', '$PROVIDER');
ALTER SYSTEM SET pg_tde.wal_encrypt = on;
ALTER SYSTEM SET default_table_access_method = 'tde_heap';
SQL
echo "pg_tde: key $KEY from $PROVIDER; WAL encryption and tde_heap take effect on the next start"
