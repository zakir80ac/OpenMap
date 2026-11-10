#!/bin/sh
# REQ-SEC-011 (ADR-067, ADR-068) — runs as root before OpenBao starts, every time the stack starts, idempotently:
#   1. the static seal key (32 random bytes), generated once;
#   2. ownership of OpenBao's volumes, and of the volume the agent beside PostgreSQL writes pg_tde's token to;
#   3. (ADR-068) a bootstrap TLS certificate for OpenBao's listener, made once: OpenBao must serve TLS before its own
#      internal services CA exists. `bao server -dev -dev-tls` writes a fresh CA (its key is never written, so it can
#      sign nothing else) and a server certificate for localhost and this container's hostname (OPENBAO_TLS_NAME, the
#      name clients connect to); the dev server runs on loopback for those few seconds and keeps nothing. The bootstrap
#      CA goes on the service-ca volume, where openbao-init adds it to the bundle every client trusts, and it seeds that
#      bundle until openbao-init first writes it. The openbao-certs agent replaces the bootstrap certificate with one
#      from the internal CA as soon as OpenBao is up.
set -eu
UNSEAL=/openbao/unseal/unseal.key
TLS_DIR=/openbao/tls
CA_DIR=/openbao/service-ca
BOOTSTRAP_CA="$CA_DIR/openbao-bootstrap-ca.crt"
BUNDLE="$CA_DIR/services-ca.crt"
OPENBAO_UID="${OPENBAO_UID:-100}"
OPENBAO_GID="${OPENBAO_GID:-1000}"
WAIT="${OPENBAO_TLS_WAIT_SECONDS:-60}"

log() { printf '{"msg":"%s"}\n' "$1"; }

[ -s "$UNSEAL" ] || head -c 32 /dev/urandom > "$UNSEAL"
chown -R openbao:openbao /openbao/unseal /openbao/data
chmod 0400 "$UNSEAL"
chown 26:26 /run/pgtde
chmod 0750 /run/pgtde

if [ ! -s "$TLS_DIR/tls.pem" ]; then
  [ "$(hostname)" = "${OPENBAO_TLS_NAME:-openbao}" ] || { log "hostname must be ${OPENBAO_TLS_NAME:-openbao}: the bootstrap certificate names it"; exit 1; }
  work=$(mktemp -d)
  bao server -dev -dev-tls -dev-tls-cert-dir="$work" -dev-listen-address=127.0.0.1:8299 > "$work/server.log" 2>&1 &
  dev=$!
  tries=0
  until [ -s "$work/vault-key.pem" ] && [ -s "$work/vault-cert.pem" ] && [ -s "$work/vault-ca.pem" ]; do
    tries=$((tries + 1))
    [ "$tries" -gt "$WAIT" ] && { kill "$dev" 2>/dev/null; log "the bootstrap certificate was not written"; exit 1; }
    sleep 1
  done
  # Copied before the dev server stops: it removes the files it generated when it exits.
  umask 077
  cat "$work/vault-cert.pem" "$work/vault-key.pem" > "$TLS_DIR/tls.pem.tmp"
  cp "$work/vault-ca.pem" "$BOOTSTRAP_CA.tmp"
  kill "$dev" 2>/dev/null || true
  wait "$dev" 2>/dev/null || true
  grep -q 'PRIVATE KEY' "$TLS_DIR/tls.pem.tmp" && grep -q CERTIFICATE "$BOOTSTRAP_CA.tmp" || { log "the bootstrap certificate is incomplete"; exit 1; }
  chown "$OPENBAO_UID:$OPENBAO_GID" "$TLS_DIR/tls.pem.tmp"
  mv "$TLS_DIR/tls.pem.tmp" "$TLS_DIR/tls.pem"
  chmod 0444 "$BOOTSTRAP_CA.tmp"
  mv "$BOOTSTRAP_CA.tmp" "$BOOTSTRAP_CA"
  rm -rf "$work"
  log "bootstrap TLS certificate made for OpenBao's listener"
fi
chown -R "$OPENBAO_UID:$OPENBAO_GID" "$TLS_DIR"
chmod 0700 "$TLS_DIR"

# Until openbao-init writes the bundle (internal CA and bootstrap CA), the bootstrap CA alone lets it reach OpenBao.
if [ ! -s "$BUNDLE" ]; then
  cp "$BOOTSTRAP_CA" "$BUNDLE"
  chmod 0444 "$BUNDLE"
elif ! grep -qxF "$(sed -n 2p "$BOOTSTRAP_CA")" "$BUNDLE"; then
  # An install from before ADR-068's OpenBao step: the bundle holds the internal CA only, written without a final
  # newline, so the bootstrap CA goes on a line of its own.
  { cat "$BUNDLE"; echo; cat "$BOOTSTRAP_CA"; } > "$BUNDLE.tmp"
  chmod 0444 "$BUNDLE.tmp"
  mv -f "$BUNDLE.tmp" "$BUNDLE"
fi
