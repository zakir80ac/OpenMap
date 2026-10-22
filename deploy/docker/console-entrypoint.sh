#!/bin/sh
# REQ-INT-001 REQ-UI-003 — console start: rewrite the build-time sentinels (see console.Dockerfile) to this
# container's public settings, then start Next's standalone server on CONSOLE_PORT. Every variable is required;
# compose and the Helm chart always pass them, and a missing one is a deployment error worth stopping on.
set -eu
: "${PUBLIC_API_URL:?PUBLIC_API_URL is required (the API origin the browser uses)}"
: "${PUBLIC_KEYCLOAK_URL:?PUBLIC_KEYCLOAK_URL is required (the Keycloak origin the browser uses)}"
: "${KEYCLOAK_REALM:?KEYCLOAK_REALM is required}"
: "${KEYCLOAK_CLIENT_ID:?KEYCLOAK_CLIENT_ID is required}"
: "${CONSOLE_PORT:?CONSOLE_PORT is required}"

app=/app/apps/console
# Trailing slashes would double up in the URLs the bundle builds.
api="${PUBLIC_API_URL%/}"
keycloak="${PUBLIC_KEYCLOAK_URL%/}"

replace() {
  # $1 sentinel, $2 value; `|` never appears in an origin, realm or client id, so it is a safe sed delimiter.
  grep -rl --include='*.js' --include='*.html' --include='*.json' --include='*.txt' -- "$1" "$app/.next" "$app/server.js" 2>/dev/null \
    | while IFS= read -r file; do sed -i "s|$1|$2|g" "$file"; done
}
replace 'http://openmap-public-api.invalid' "$api"
replace 'http://openmap-public-keycloak.invalid' "$keycloak"
replace 'openmap-realm-set-at-start' "$KEYCLOAK_REALM"
replace 'openmap-client-set-at-start' "$KEYCLOAK_CLIENT_ID"

export PORT="$CONSOLE_PORT"
# Bind every interface: the container's port is published by compose or exposed by the Service.
export HOSTNAME=0.0.0.0
cd "$app"
exec node server.js
