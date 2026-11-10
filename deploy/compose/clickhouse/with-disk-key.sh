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
exec /entrypoint.sh "$@"
