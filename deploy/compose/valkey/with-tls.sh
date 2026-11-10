#!/bin/sh
# REQ-SEC-011 (ADR-068) — starts Valkey with TLS only and keeps its certificate current without a restart.
#
# The OpenBao Agent renders the certificate and key (one PEM) to VALKEY_TLS_SOURCE. This wrapper copies it to a new file
# in VALKEY_TLS_LIVE_DIR and starts Valkey on it, with the plain port closed. When the agent renews the PEM, the wrapper
# copies it to a new file and points Valkey at that one with CONFIG SET, which makes Valkey load it for new connections
# (Valkey takes no new certificate from a file whose name it already has). Valkey runs as its own user through the
# image's entrypoint; the wrapper forwards SIGTERM to it and exits with it.
set -eu
SOURCE="${VALKEY_TLS_SOURCE:-/run/valkey-tls/tls.pem}"
LIVE="${VALKEY_TLS_LIVE_DIR:-/run/valkey-live}"
CA="${VALKEY_TLS_CA:-/run/openmap/ca/services-ca.crt}"
PORT="${VALKEY_TLS_PORT:-6379}"
WAIT="${VALKEY_TLS_WAIT_SECONDS:-120}"
EVERY="${VALKEY_TLS_CHECK_SECONDS:-30}"

tries=0
until [ -s "$SOURCE" ]; do
  tries=$((tries + 1))
  [ "$tries" -gt "$WAIT" ] && { echo "valkey: no certificate at $SOURCE after ${WAIT}s" >&2; exit 1; }
  sleep 1
done

mkdir -p "$LIVE"
chown valkey:valkey "$LIVE"
chmod 0700 "$LIVE"

# Copies the agent's PEM to a file named after its checksum and prints that name.
install_pem() {
  sum=$(cksum < "$SOURCE" | cut -d' ' -f1)
  dest="$LIVE/tls-$sum.pem"
  if [ ! -f "$dest" ]; then
    cp "$SOURCE" "$dest.tmp"
    chown valkey:valkey "$dest.tmp"
    chmod 0600 "$dest.tmp"
    mv "$dest.tmp" "$dest"
  fi
  printf '%s' "$dest"
}

current=$(install_pem)
docker-entrypoint.sh valkey-server "$@" --port 0 --tls-port "$PORT" \
  --tls-cert-file "$current" --tls-key-file "$current" --tls-auth-clients no &
child=$!
trap 'kill -TERM "$child" 2>/dev/null' TERM INT

while kill -0 "$child" 2>/dev/null; do
  sleep "$EVERY" &
  wait $! || true
  kill -0 "$child" 2>/dev/null || break
  # The agent replaces the file in one rename; a moment without one keeps the current certificate.
  [ -s "$SOURCE" ] || continue
  next=$(install_pem)
  [ "$next" = "$current" ] && continue
  if valkey-cli --tls --cacert "$CA" -h localhost -p "$PORT" CONFIG SET tls-cert-file "$next" tls-key-file "$next" | grep -q OK; then
    rm -f "$current"
    current="$next"
    echo "valkey: renewed certificate loaded" >&2
  else
    echo "valkey: renewed certificate not accepted; keeping the current one" >&2
    rm -f "$next"
  fi
done
wait "$child"
