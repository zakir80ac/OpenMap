#!/bin/sh
# REQ-INT-019 (ADR-066) — scripted logical backups of OpenMap's stores of record, and their restore.
#
#   openmap-backup create [NAME]        Postgres custom archive (pg_dump -Fc) and a ClickHouse native BACKUP into
#                                       $BACKUP_DIR/NAME, with manifest.json (sizes, sha256, migration, CI count);
#                                       then keeps the newest $BACKUP_KEEP complete sets.
#   openmap-backup verify NAME          Checks the checksums and that pg_restore can read the archive.
#   openmap-backup restore NAME [--postgres-url URL] [--clickhouse-db DB]
#                                       Restores Postgres (pg_restore --clean) and ClickHouse (DROP + RESTORE) into the
#                                       configured stores, or into the ones given. Rebuild Memgraph and Meilisearch
#                                       afterwards with the reconciler's `reproject`.
#   openmap-backup list                 Prints every set's manifest, newest first.
#   openmap-backup prune                Keeps the newest $BACKUP_KEEP complete sets.
#
# Environment (the compose `backup` service sets these from the same .env as the services):
#   POSTGRES_URL, CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, CLICKHOUSE_DB,
#   BACKUP_DIR (this container's view of the backup volume, which the ClickHouse server mounts at its
#   backups.allowed_path), BACKUP_KEEP, CLICKHOUSE_UID (the server's user, which writes the ClickHouse part).
# Memgraph and Meilisearch are projections of Postgres; they are not in a backup set.
set -eu

FORMAT="openmap-backup/1"
MANIFEST="manifest.json"
PG_FILE="postgres.dump"
CH_DIR="clickhouse"
: "${BACKUP_DIR:?BACKUP_DIR is required}"
: "${POSTGRES_URL:?POSTGRES_URL is required}"
: "${CLICKHOUSE_URL:?CLICKHOUSE_URL is required}"
: "${CLICKHOUSE_DB:?CLICKHOUSE_DB is required}"
CLICKHOUSE_USER="${CLICKHOUSE_USER:-default}"
CLICKHOUSE_PASSWORD="${CLICKHOUSE_PASSWORD:-}"
BACKUP_KEEP="${BACKUP_KEEP:-7}"
CLICKHOUSE_UID="${CLICKHOUSE_UID:-101}"

log() { printf '{"msg":"%s","backup":"%s"}\n' "$1" "${2:-}" >&2; }
now() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
die() { log "$1" "${2:-}"; exit 1; }

# Runs one ClickHouse statement over HTTP; the server's error text is printed and fails the script.
ch() {
  out=$(curl -sS --fail-with-body -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" --data-binary "$1" "$CLICKHOUSE_URL/") || die "clickhouse: $out"
  printf '%s' "$out"
}

json_string() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

write_manifest() {
  # $1 dir, $2 name, $3 status, $4 createdAt, $5 completedAt|null, $6 postgres json|null, $7 clickhouse json|null, $8 error|null
  completed=null; [ "$5" = null ] || completed=$(json_string "$5")
  error=null; [ "$8" = null ] || error=$(json_string "$8")
  printf '{"format":"%s","name":%s,"status":"%s","createdAt":"%s","completedAt":%s,"postgres":%s,"clickhouse":%s,"derived":["memgraph","meilisearch"],"error":%s}\n' \
    "$FORMAT" "$(json_string "$2")" "$3" "$4" "$completed" "$6" "$7" "$error" > "$1/$MANIFEST.tmp"
  mv "$1/$MANIFEST.tmp" "$1/$MANIFEST"
}

dir_digest() {
  # sha256 of the sorted "<sha256>  <relative path>" list of every file under $1.
  (cd "$1" && find . -type f -print | LC_ALL=C sort | while read -r f; do sha256sum "$f"; done) | sha256sum | cut -d' ' -f1
}

create() {
  name="${1:-openmap-$(date -u +%Y%m%dT%H%M%SZ)}"
  case "$name" in *[!A-Za-z0-9._-]*) die "backup names take letters, digits, dot, dash and underscore" "$name" ;; esac
  dir="$BACKUP_DIR/$name"
  [ -e "$dir" ] && die "backup already exists" "$name"
  mkdir -p "$dir"
  started=$(now)
  write_manifest "$dir" "$name" running "$started" null null null null
  log "backup started" "$name"
  trap 'write_manifest "$dir" "$name" failed "$started" "$(now)" null null "interrupted or failed; see the backup log"; log "backup failed" "$name"' EXIT

  pg_dump --format=custom --no-owner --no-privileges --file="$dir/$PG_FILE" "$POSTGRES_URL"
  pg_bytes=$(stat -c %s "$dir/$PG_FILE")
  pg_sha=$(sha256sum "$dir/$PG_FILE" | cut -d' ' -f1)
  migration=$(psql "$POSTGRES_URL" -Atc "SELECT coalesce(max(migration_name), '') FROM _prisma_migrations WHERE finished_at IS NOT NULL")
  cis=$(psql "$POSTGRES_URL" -Atc 'SELECT count(*) FROM cis WHERE "validTo" IS NULL')
  log "postgres archived" "$name"

  # The ClickHouse server writes this directory as its own user (CLICKHOUSE_UID in the official image).
  chown "$CLICKHOUSE_UID" "$dir"
  ch "BACKUP DATABASE $CLICKHOUSE_DB TO File('$name/$CH_DIR')" > /dev/null
  [ -d "$dir/$CH_DIR" ] || die "the ClickHouse backup is not on the shared volume; check the volume and backups.allowed_path" "$name"
  ch_bytes=$(du -sb "$dir/$CH_DIR" | cut -f1)
  ch_files=$(find "$dir/$CH_DIR" -type f | wc -l | tr -d ' ')
  ch_sha=$(dir_digest "$dir/$CH_DIR")
  log "clickhouse backed up" "$name"

  pg_json=$(printf '{"file":"%s","bytes":%s,"sha256":"%s","migration":%s,"cis":%s}' "$PG_FILE" "$pg_bytes" "$pg_sha" "$(json_string "$migration")" "$cis")
  ch_json=$(printf '{"directory":"%s","database":"%s","bytes":%s,"files":%s,"sha256":"%s"}' "$CH_DIR" "$CLICKHOUSE_DB" "$ch_bytes" "$ch_files" "$ch_sha")
  trap - EXIT
  write_manifest "$dir" "$name" complete "$started" "$(now)" "$pg_json" "$ch_json" null
  log "backup complete" "$name"
  prune
}

verify() {
  name="${1:?backup name required}"
  dir="$BACKUP_DIR/$name"
  [ -f "$dir/$MANIFEST" ] || die "no manifest" "$name"
  grep -q '"status":"complete"' "$dir/$MANIFEST" || die "backup is not complete" "$name"
  pg_sha=$(sed -n 's/.*"postgres":{[^}]*"sha256":"\([a-f0-9]*\)".*/\1/p' "$dir/$MANIFEST")
  ch_sha=$(sed -n 's/.*"clickhouse":{[^}]*"sha256":"\([a-f0-9]*\)".*/\1/p' "$dir/$MANIFEST")
  [ "$(sha256sum "$dir/$PG_FILE" | cut -d' ' -f1)" = "$pg_sha" ] || die "postgres archive checksum differs" "$name"
  [ "$(dir_digest "$dir/$CH_DIR")" = "$ch_sha" ] || die "clickhouse backup checksum differs" "$name"
  pg_restore --list "$dir/$PG_FILE" > /dev/null || die "pg_restore cannot read the archive" "$name"
  log "backup verified" "$name"
}

restore() {
  name="${1:?backup name required}"
  shift
  target_url="$POSTGRES_URL"
  target_db="$CLICKHOUSE_DB"
  while [ $# -gt 0 ]; do
    case "$1" in
      --postgres-url) target_url="$2"; shift 2 ;;
      --clickhouse-db) target_db="$2"; shift 2 ;;
      *) die "unknown option $1" "$name" ;;
    esac
  done
  verify "$name"
  dir="$BACKUP_DIR/$name"
  source_db=$(sed -n 's/.*"clickhouse":{[^}]*"database":"\([^"]*\)".*/\1/p' "$dir/$MANIFEST")
  log "restore started" "$name"
  pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction --dbname="$target_url" "$dir/$PG_FILE"
  log "postgres restored" "$name"
  ch "DROP DATABASE IF EXISTS $target_db SYNC" > /dev/null
  ch "RESTORE DATABASE $source_db AS $target_db FROM File('$name/$CH_DIR')" > /dev/null
  log "clickhouse restored" "$name"
  log "restore complete; rebuild Memgraph and Meilisearch with the reconciler's reproject" "$name"
}

list() {
  for m in $(ls -1d "$BACKUP_DIR"/*/ 2>/dev/null | LC_ALL=C sort -r); do
    [ -f "$m$MANIFEST" ] && cat "$m$MANIFEST"
  done
  return 0
}

prune() {
  kept=0
  for m in $(ls -1d "$BACKUP_DIR"/*/ 2>/dev/null | LC_ALL=C sort -r); do
    if [ -f "$m$MANIFEST" ] && grep -q '"status":"complete"' "$m$MANIFEST"; then
      kept=$((kept + 1))
      if [ "$kept" -gt "$BACKUP_KEEP" ]; then
        rm -rf "$m"
        log "pruned" "$(basename "$m")"
      fi
    fi
  done
}

command="${1:-create}"
[ $# -gt 0 ] && shift
case "$command" in
  create) create "$@" ;;
  verify) verify "$@" ;;
  restore) restore "$@" ;;
  list) list ;;
  prune) prune ;;
  *) die "usage: openmap-backup create|verify|restore|list|prune" ;;
esac
