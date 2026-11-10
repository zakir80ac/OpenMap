#!/bin/sh
# REQ-SEC-011 (ADR-068) — runs a store that reads its TLS certificate only at start (Memgraph, Meilisearch), and stops it
# when the OpenBao Agent renews that certificate, so the container's restart policy starts it again on the new one.
#
#   restart-on-renewal.sh <pem> <command> [args...]
#
# Waits up to TLS_WAIT_SECONDS for <pem>, starts the command, and compares the PEM's checksum every TLS_CHECK_SECONDS.
# On a change it sends SIGTERM to the store, waits for it and exits 0. If the store exits on its own, so does this script,
# with its status. SIGTERM to the script is passed on to the store.
set -eu
PEM="$1"
shift
WAIT="${TLS_WAIT_SECONDS:-120}"
EVERY="${TLS_CHECK_SECONDS:-60}"

tries=0
until [ -s "$PEM" ]; do
  tries=$((tries + 1))
  [ "$tries" -gt "$WAIT" ] && { echo "no certificate at $PEM after ${WAIT}s" >&2; exit 1; }
  sleep 1
done
started=$(cksum < "$PEM")

"$@" &
child=$!
trap 'kill -TERM "$child" 2>/dev/null' TERM INT

while kill -0 "$child" 2>/dev/null; do
  sleep "$EVERY" &
  wait $! || true
  kill -0 "$child" 2>/dev/null || break
  if [ -s "$PEM" ] && [ "$(cksum < "$PEM")" != "$started" ]; then
    echo "certificate at $PEM renewed: restarting" >&2
    kill -TERM "$child"
    wait "$child" || true
    exit 0
  fi
done
wait "$child"
