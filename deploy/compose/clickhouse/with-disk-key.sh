#!/bin/sh
# REQ-SEC-011 (ADR-067 step 6) — starts ClickHouse with its encrypted disk's key: waits for the file the OpenBao Agent
# renders (CLICKHOUSE_DISK_KEY_FILE), puts it in CLICKHOUSE_DISK_KEY, which config.d/encrypted-disk.xml reads, and hands
# over to the image's entrypoint. Without the key the server does not start: it could not read its data.
set -eu
KEY_FILE="${CLICKHOUSE_DISK_KEY_FILE:-/run/clickhouse-key/key}"
WAIT="${CLICKHOUSE_DISK_KEY_WAIT_SECONDS:-120}"
tries=0
until [ -s "$KEY_FILE" ]; do
  tries=$((tries + 1))
  [ "$tries" -gt "$WAIT" ] && { echo "clickhouse: no disk key at $KEY_FILE after ${WAIT}s" >&2; exit 1; }
  sleep 1
done
CLICKHOUSE_DISK_KEY=$(tr -d ' \n' < "$KEY_FILE")
export CLICKHOUSE_DISK_KEY
# ADR-068: on an empty data directory the image's entrypoint creates CLICKHOUSE_DB with clickhouse-client over the
# plain native port, which tls.xml closes; init then fails and the container restarts unhealthy. The migrations create
# the database (over TLS), so the entrypoint is not asked to; it still creates the user from its configuration.
unset CLICKHOUSE_DB
exec /entrypoint.sh "$@"
