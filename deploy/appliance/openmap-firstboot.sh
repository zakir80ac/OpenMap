#!/bin/sh
# REQ-INT-018 — first boot of the OpenMap appliance VM. The image carries the stack and the air-gap bundle with the
# development defaults of .env.example; on its first start each appliance gets its own secrets and its own public
# address, before the stack starts for the first time:
#   - every password and key in .env replaced by a fresh random value (32 characters from /dev/urandom), including
#     the password inside the host-side POSTGRES_URL;
#   - the public URLs (console, API, Keycloak, Superset, scheduler) set to OPENMAP_PUBLIC_HOST, or the VM's first
#     address when unset;
#   - the generated administrator credentials written once to OPENMAP_CREDENTIALS_FILE (mode 0600) for the operator
#     to read, store and rotate; the console banner (/etc/issue.d) names the console URL.
# It runs once: a marker file stops a second run from changing secrets a running stack already uses.
set -eu

ROOT="${OPENMAP_ROOT:-/opt/openmap}"
ENV_FILE="${OPENMAP_ENV_FILE:-$ROOT/.env}"
EXAMPLE="${OPENMAP_ENV_EXAMPLE:-$ROOT/.env.example}"
STATE_DIR="${OPENMAP_STATE_DIR:-/var/lib/openmap}"
MARK="$STATE_DIR/firstboot.done"
CREDENTIALS="${OPENMAP_CREDENTIALS_FILE:-/root/openmap-credentials.txt}"
ISSUE_DIR="${OPENMAP_ISSUE_DIR:-/etc/issue.d}"
SECRET_LENGTH="${OPENMAP_SECRET_LENGTH:-32}"
CONSOLE_PORT="${CONSOLE_PORT:-3000}"
API_PORT="${API_PORT:-4000}"
KEYCLOAK_PORT="${KEYCLOAK_PORT:-8080}"
SUPERSET_PORT="${SUPERSET_PORT:-8088}"
SCHEDULER_PORT="${SCHEDULER_PORT:-7443}"

log() { printf '{"msg":"%s"}\n' "$1"; }

if [ -f "$MARK" ]; then
  log "first boot already done; secrets left as they are"
  exit 0
fi

secret() { tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$SECRET_LENGTH"; }

host="${OPENMAP_PUBLIC_HOST:-}"
if [ -z "$host" ]; then
  host=$(hostname -I 2>/dev/null | awk '{print $1}')
fi
[ -n "$host" ] || host=$(hostname)

umask 077
mkdir -p "$STATE_DIR"
[ -f "$ENV_FILE" ] || cp "$EXAMPLE" "$ENV_FILE"

# set KEY VALUE: replaces the key's line, or appends it.
set_key() {
  if grep -q "^$1=" "$ENV_FILE"; then
    tmp="$ENV_FILE.tmp"
    awk -v k="$1" -v v="$2" 'BEGIN { FS = OFS = "=" } $1 == k { print k "=" v; next } { print }' "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}

postgres_password=$(secret)
keycloak_password=$(secret)
superset_password=$(secret)
set_key POSTGRES_PASSWORD "$postgres_password"
set_key CLICKHOUSE_PASSWORD "$(secret)"
set_key MEILI_MASTER_KEY "$(secret)"
set_key KEYCLOAK_ADMIN_PASSWORD "$keycloak_password"
set_key SUPERSET_SECRET_KEY "$(secret)"
set_key SUPERSET_ADMIN_PASSWORD "$superset_password"
set_key DNS_LAB_TSIG_SECRET "$(secret)"

# The host-side URL carries the password: rebuilt from the same user, port and database with the new one.
pg_user=$(sed -n 's/^POSTGRES_USER=//p' "$ENV_FILE")
pg_db=$(sed -n 's/^POSTGRES_DB=//p' "$ENV_FILE")
pg_port=$(sed -n 's/^POSTGRES_PORT=//p' "$ENV_FILE")
pg_query=$(sed -n 's/^POSTGRES_URL="[^?]*?\(.*\)"$/\1/p' "$ENV_FILE")
set_key POSTGRES_URL "\"postgresql://$pg_user:$postgres_password@localhost:$pg_port/$pg_db${pg_query:+?$pg_query}\""

set_key PUBLIC_CONSOLE_URL "http://$host:$CONSOLE_PORT"
set_key PUBLIC_CONSOLE_ALIAS_URL "http://$host:$CONSOLE_PORT"
set_key PUBLIC_API_URL "http://$host:$API_PORT"
set_key PUBLIC_KEYCLOAK_URL "http://$host:$KEYCLOAK_PORT"
set_key PUBLIC_SUPERSET_URL "http://$host:$SUPERSET_PORT"
set_key PUBLIC_SCHEDULER_URL "https://$host:$SCHEDULER_PORT"
set_key SCHEDULER_TLS_EXTRA_SANS "$host"
chmod 0600 "$ENV_FILE"

mkdir -p "$(dirname "$CREDENTIALS")"
cat > "$CREDENTIALS" <<EOF
OpenMap appliance, first boot $(date -u +%Y-%m-%dT%H:%M:%SZ)
Console:            http://$host:$CONSOLE_PORT
Keycloak admin:     admin / $keycloak_password   (http://$host:$KEYCLOAK_PORT)
Superset admin:     admin / $superset_password
Every other secret is in $ENV_FILE (mode 0600).
Store these elsewhere, change the passwords, then delete this file.
OpenBao's recovery keys and initial root token are written by openbao-init into its init volume: move them offline.
EOF
chmod 0600 "$CREDENTIALS"

if [ -d "$ISSUE_DIR" ] || mkdir -p "$ISSUE_DIR" 2>/dev/null; then
  printf 'OpenMap console: http://%s:%s  (credentials: %s)\n' "$host" "$CONSOLE_PORT" "$CREDENTIALS" > "$ISSUE_DIR/openmap.issue"
fi

touch "$MARK"
log "first boot done: secrets generated, public address $host"
