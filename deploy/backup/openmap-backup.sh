#!/bin/sh
# REQ-INT-019 (ADR-066) — scripted logical backups of OpenMap's stores of record, and their restore.
#
#   openmap-backup create [NAME]        Postgres custom archive (pg_dump -Fc) and a ClickHouse native BACKUP into
#                                       $BACKUP_DIR/NAME, with manifest.json (sizes, sha256, migration, CI count);
#                                       then keeps the newest $BACKUP_KEEP complete sets.
#   openmap-backup verify NAME          Checks the checksums and that pg_restore can read the archive.
#   openmap-backup restore NAME [--postgres-url URL] [--clickhouse-db DB] [--postgres-only | --clickhouse-only]
#                                       Restores Postgres (pg_restore --clean, tables on the target's default access
#                                       method) and ClickHouse (DROP + RESTORE) into the configured stores, or into
#                                       the ones given; --postgres-only leaves ClickHouse alone (moving Postgres to a
#                                       new server). Rebuild Memgraph and Meilisearch afterwards with the reconciler's
#                                       `reproject` (not needed when only Postgres moved and its data is unchanged).
#   openmap-backup list                 Prints every set's manifest, newest first.
#   openmap-backup prune                Keeps the newest $BACKUP_KEEP complete sets.
#
# Environment (the compose `backup` service sets these from the same .env as the services):
#   POSTGRES_URL, CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, CLICKHOUSE_DB,
#   BACKUP_DIR (this container's view of the backup volume, which the ClickHouse server mounts at its
#   backups.allowed_path), BACKUP_KEEP, CLICKHOUSE_UID (the server's user, which writes the ClickHouse part).
# ADR-068: over https OpenBao is verified against OPENBAO_CA (the internal services CA bundle).
# REQ-SEC-011 (ADR-067): with OPENBAO_ADDR and the backup AppRole files (OPENBAO_ROLE_ID_FILE, OPENBAO_SECRET_ID_FILE)
# set, the set also holds an OpenBao Raft snapshot. It is restored by an operator (`bao operator raft snapshot restore`)
# and needs the same seal key; `restore` here leaves OpenBao alone.
# Memgraph and Meilisearch are projections of Postgres; they are not in a backup set.
set -eu

FORMAT="openmap-backup/1"
MANIFEST="manifest.json"
PG_FILE="postgres.dump"
CH_DIR="clickhouse"
BAO_FILE="openbao.snap"
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
  # ADR-068: over https the server is verified against CLICKHOUSE_CA (the internal services CA).
  out=$(curl -sS --fail-with-body ${CLICKHOUSE_CA:+--cacert "$CLICKHOUSE_CA"} -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" --data-binary "$1" "$CLICKHOUSE_URL/") || die "clickhouse: $out"
  printf '%s' "$out"
}

json_string() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

write_manifest() {
  # $1 dir, $2 name, $3 status, $4 createdAt, $5 completedAt|null, $6 postgres json|null, $7 clickhouse json|null, $8 error|null, $9 openbao json|null, $10 encryption json|null
  completed=null; [ "$5" = null ] || completed=$(json_string "$5")
  error=null; [ "$8" = null ] || error=$(json_string "$8")
  printf '{"format":"%s","name":%s,"status":"%s","createdAt":"%s","completedAt":%s,"postgres":%s,"clickhouse":%s,"openbao":%s,"encryption":%s,"derived":["memgraph","meilisearch"],"error":%s}\n' \
    "$FORMAT" "$(json_string "$2")" "$3" "$4" "$completed" "$6" "$7" "${9:-null}" "${10:-null}" "$error" > "$1/$MANIFEST.tmp"
  mv "$1/$MANIFEST.tmp" "$1/$MANIFEST"
}

# --- REQ-SEC-011 (ADR-067 step 5): encrypted backup files ------------------------------------------------------
# Each set gets a fresh 256-bit data key from Transit (`datakey/plaintext/openmap-backup`); only the wrapped key is
# written to the manifest. Files are encrypted then authenticated: AES-256-CTR with a key and an HMAC-SHA256 over the
# ciphertext with another, both derived from the data key (HMAC-SHA256 of "enc" and "mac"). The OpenBao snapshot stays
# as OpenBao wrote it: its storage barrier already encrypts it with the seal key, and it must restore without OpenBao.
# BACKUP_ENCRYPTION=required (default) refuses to write a set without OpenBao; =off writes plaintext sets.
BACKUP_ENCRYPTION="${BACKUP_ENCRYPTION:-required}"
BACKUP_KEY="${BACKUP_TRANSIT_KEY:-openmap-backup}"

bao_token() {
  [ -n "${OPENBAO_ADDR:-}" ] && [ -n "${OPENBAO_ROLE_ID_FILE:-}" ] && [ -n "${OPENBAO_SECRET_ID_FILE:-}" ] || return 1
  login=$(curl -sS --fail-with-body ${OPENBAO_CA:+--cacert "$OPENBAO_CA"} -X POST -H 'content-type: application/json' \
    --data "{\"role_id\":\"$(tr -d '\n' < "$OPENBAO_ROLE_ID_FILE")\",\"secret_id\":\"$(tr -d '\n' < "$OPENBAO_SECRET_ID_FILE")\"}" \
    "$OPENBAO_ADDR/v1/auth/approle/login") || die "openbao: AppRole login refused" "${name:-}"
  printf '%s' "$login" | sed -n 's/.*"client_token":"\([^"]*\)".*/\1/p'
}

json_field() { sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p"; }
hex_of_b64() { printf '%s' "$1" | base64 -d | od -An -v -tx1 | tr -d ' \n'; }
derive() { printf '%s' "$2" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$1" | sed 's/.*= //'; }

# Sets DATA_KEY_HEX and WRAPPED_KEY from a new Transit data key.
new_data_key() {
  out=$(curl -sS --fail-with-body ${OPENBAO_CA:+--cacert "$OPENBAO_CA"} -X POST -H "X-Vault-Token: $1" "$OPENBAO_ADDR/v1/transit/datakey/plaintext/$BACKUP_KEY") ||
    die "openbao: data key refused" "${name:-}"
  WRAPPED_KEY=$(printf '%s' "$out" | json_field ciphertext)
  DATA_KEY_HEX=$(hex_of_b64 "$(printf '%s' "$out" | json_field plaintext)")
  [ -n "$WRAPPED_KEY" ] && [ -n "$DATA_KEY_HEX" ] || die "openbao: no data key in the response" "${name:-}"
}

# Sets DATA_KEY_HEX from the wrapped key in a manifest.
unwrap_data_key() {
  token=$(bao_token) || die "the set is encrypted: OPENBAO_ADDR and the backup AppRole files are needed" "${name:-}"
  out=$(curl -sS --fail-with-body ${OPENBAO_CA:+--cacert "$OPENBAO_CA"} -X POST -H "X-Vault-Token: $token" -H 'content-type: application/json' \
    --data "{\"ciphertext\":\"$1\"}" "$OPENBAO_ADDR/v1/transit/decrypt/$BACKUP_KEY") || die "openbao: the set's key was refused" "${name:-}"
  DATA_KEY_HEX=$(hex_of_b64 "$(printf '%s' "$out" | json_field plaintext)")
}

# seal IN OUT: encrypts IN to OUT, prints "<iv> <mac>".
seal() {
  iv=$(openssl rand -hex 16)
  openssl enc -aes-256-ctr -K "$(derive "$DATA_KEY_HEX" enc)" -iv "$iv" -in "$1" -out "$2"
  printf '%s %s' "$iv" "$(openssl dgst -sha256 -mac HMAC -macopt "hexkey:$(derive "$DATA_KEY_HEX" mac)" "$2" | sed 's/.*= //')"
}

# check_mac FILE MAC: the HMAC over the ciphertext matches (before anything reads the plaintext).
check_mac() {
  [ "$(openssl dgst -sha256 -mac HMAC -macopt "hexkey:$(derive "$DATA_KEY_HEX" mac)" "$1" | sed 's/.*= //')" = "$2" ]
}

# open_file IN IV: decrypted IN on stdout.
open_file() { openssl enc -d -aes-256-ctr -K "$(derive "$DATA_KEY_HEX" enc)" -iv "$2" -in "$1"; }

# manifest_value SECTION KEY: a string field of one object of the manifest.
manifest_value() { sed -n "s/.*\"$1\":{[^}]*\"$2\":\"\\([^\"]*\\)\".*/\\1/p" "$dir/$MANIFEST"; }

dir_digest() {
  # sha256 of the sorted "<sha256>  <relative path>" list of every file under $1.
  (cd "$1" && find . -type f -print | LC_ALL=C sort | while read -r f; do sha256sum "$f"; done) | sha256sum | cut -d' ' -f1
}

create() {
  name="${1:-openmap-$(date -u +%Y%m%dT%H%M%SZ)}"
  case "$name" in *[!A-Za-z0-9._-]*) die "backup names take letters, digits, dot, dash and underscore" "$name" ;; esac
  token=$(bao_token) || token=""
  if [ -z "$token" ] && [ "$BACKUP_ENCRYPTION" != off ]; then
    die "encrypted backups need OPENBAO_ADDR and the backup AppRole files (or BACKUP_ENCRYPTION=off)" "$name"
  fi
  dir="$BACKUP_DIR/$name"
  [ -e "$dir" ] && die "backup already exists" "$name"
  mkdir -p "$dir"
  started=$(now)
  write_manifest "$dir" "$name" running "$started" null null null null
  log "backup started" "$name"
  trap 'write_manifest "$dir" "$name" failed "$started" "$(now)" null null "interrupted or failed; see the backup log"; log "backup failed" "$name"' EXIT

  # pg_tde is server configuration (its key provider and keys live with the server, not in the dump): left out, so the
  # archive restores into stock or encrypted PostgreSQL alike (ADR-067).
  pg_dump --format=custom --no-owner --no-privileges --exclude-extension=pg_tde --file="$dir/$PG_FILE" "$POSTGRES_URL"
  migration=$(psql "$POSTGRES_URL" -Atc "SELECT coalesce(max(migration_name), '') FROM _prisma_migrations WHERE finished_at IS NOT NULL")
  cis=$(psql "$POSTGRES_URL" -Atc 'SELECT count(*) FROM cis WHERE "validTo" IS NULL')
  log "postgres archived" "$name"

  # The ClickHouse server writes this directory as its own user (CLICKHOUSE_UID in the official image).
  chown "$CLICKHOUSE_UID" "$dir"
  ch "BACKUP DATABASE $CLICKHOUSE_DB TO File('$name/$CH_DIR')" > /dev/null
  [ -d "$dir/$CH_DIR" ] || die "the ClickHouse backup is not on the shared volume; check the volume and backups.allowed_path" "$name"
  ch_bytes=$(du -sb "$dir/$CH_DIR" | cut -f1)
  ch_files=$(find "$dir/$CH_DIR" -type f | wc -l | tr -d ' ')
  log "clickhouse backed up" "$name"

  bao_json=null
  if [ -n "$token" ]; then
    curl -sS --fail ${OPENBAO_CA:+--cacert "$OPENBAO_CA"} -H "X-Vault-Token: $token" -o "$dir/$BAO_FILE" "$OPENBAO_ADDR/v1/sys/storage/raft/snapshot" || die "openbao: snapshot refused" "$name"
    bao_json=$(printf '{"file":"%s","bytes":%s,"sha256":"%s"}' "$BAO_FILE" "$(stat -c %s "$dir/$BAO_FILE")" "$(sha256sum "$dir/$BAO_FILE" | cut -d' ' -f1)")
    log "openbao snapshot taken" "$name"
  fi

  enc_json=null
  if [ "$BACKUP_ENCRYPTION" != off ]; then
    new_data_key "$token"
    sealed=$(seal "$dir/$PG_FILE" "$dir/$PG_FILE.enc")
    pg_iv=${sealed% *}
    pg_mac=${sealed#* }
    rm -f "$dir/$PG_FILE"
    pg_out="$PG_FILE.enc"
    tar -C "$dir" -cf "$dir/$CH_DIR.tar" "$CH_DIR"
    sealed=$(seal "$dir/$CH_DIR.tar" "$dir/$CH_DIR.tar.enc")
    ch_iv=${sealed% *}
    ch_mac=${sealed#* }
    rm -rf "$dir/$CH_DIR" "$dir/$CH_DIR.tar"
    enc_json=$(printf '{"cipher":"aes-256-ctr+hmac-sha256","transitKey":"%s","key":"%s"}' "$BACKUP_KEY" "$WRAPPED_KEY")
    pg_json=$(printf '{"file":"%s","bytes":%s,"sha256":"%s","iv":"%s","mac":"%s","migration":%s,"cis":%s}' \
      "$pg_out" "$(stat -c %s "$dir/$pg_out")" "$(sha256sum "$dir/$pg_out" | cut -d' ' -f1)" "$pg_iv" "$pg_mac" "$(json_string "$migration")" "$cis")
    ch_json=$(printf '{"directory":"%s","archive":"%s","database":"%s","bytes":%s,"files":%s,"sha256":"%s","iv":"%s","mac":"%s"}' \
      "$CH_DIR" "$CH_DIR.tar.enc" "$CLICKHOUSE_DB" "$ch_bytes" "$ch_files" "$(sha256sum "$dir/$CH_DIR.tar.enc" | cut -d' ' -f1)" "$ch_iv" "$ch_mac")
    log "backup encrypted" "$name"
  else
    pg_json=$(printf '{"file":"%s","bytes":%s,"sha256":"%s","migration":%s,"cis":%s}' \
      "$PG_FILE" "$(stat -c %s "$dir/$PG_FILE")" "$(sha256sum "$dir/$PG_FILE" | cut -d' ' -f1)" "$(json_string "$migration")" "$cis")
    ch_json=$(printf '{"directory":"%s","database":"%s","bytes":%s,"files":%s,"sha256":"%s"}' \
      "$CH_DIR" "$CLICKHOUSE_DB" "$ch_bytes" "$ch_files" "$(dir_digest "$dir/$CH_DIR")")
  fi
  trap - EXIT
  write_manifest "$dir" "$name" complete "$started" "$(now)" "$pg_json" "$ch_json" null "$bao_json" "$enc_json"
  log "backup complete" "$name"
  prune
}

verify() {
  name="${1:?backup name required}"
  dir="$BACKUP_DIR/$name"
  [ -f "$dir/$MANIFEST" ] || die "no manifest" "$name"
  grep -q '"status":"complete"' "$dir/$MANIFEST" || die "backup is not complete" "$name"
  pg_file=$(manifest_value postgres file)
  pg_sha=$(manifest_value postgres sha256)
  ch_sha=$(manifest_value clickhouse sha256)
  ch_archive=$(manifest_value clickhouse archive)
  wrapped=$(manifest_value encryption key)
  [ "$(sha256sum "$dir/$pg_file" | cut -d' ' -f1)" = "$pg_sha" ] || die "postgres archive checksum differs" "$name"
  if [ -n "$wrapped" ]; then
    [ "$(sha256sum "$dir/$ch_archive" | cut -d' ' -f1)" = "$ch_sha" ] || die "clickhouse backup checksum differs" "$name"
    unwrap_data_key "$wrapped"
    check_mac "$dir/$pg_file" "$(manifest_value postgres mac)" || die "postgres archive fails authentication" "$name"
    check_mac "$dir/$ch_archive" "$(manifest_value clickhouse mac)" || die "clickhouse backup fails authentication" "$name"
    open_file "$dir/$pg_file" "$(manifest_value postgres iv)" | pg_restore --list > /dev/null || die "pg_restore cannot read the archive" "$name"
  else
    [ "$(dir_digest "$dir/$CH_DIR")" = "$ch_sha" ] || die "clickhouse backup checksum differs" "$name"
    pg_restore --list "$dir/$pg_file" > /dev/null || die "pg_restore cannot read the archive" "$name"
  fi
  bao_sha=$(manifest_value openbao sha256)
  if [ -n "$bao_sha" ]; then
    [ "$(sha256sum "$dir/$BAO_FILE" | cut -d' ' -f1)" = "$bao_sha" ] || die "openbao snapshot checksum differs" "$name"
  fi
  log "backup verified" "$name"
}

restore() {
  name="${1:?backup name required}"
  shift
  target_url="$POSTGRES_URL"
  target_db="$CLICKHOUSE_DB"
  postgres_only=false
  clickhouse_only=false
  while [ $# -gt 0 ]; do
    case "$1" in
      --postgres-url) target_url="$2"; shift 2 ;;
      --clickhouse-db) target_db="$2"; shift 2 ;;
      --postgres-only) postgres_only=true; shift ;;
      --clickhouse-only) clickhouse_only=true; shift ;;
      *) die "unknown option $1" "$name" ;;
    esac
  done
  verify "$name"
  dir="$BACKUP_DIR/$name"
  source_db=$(manifest_value clickhouse database)
  wrapped=$(manifest_value encryption key)
  pg_file="$dir/$(manifest_value postgres file)"
  log "restore started" "$name"
  if [ -n "$wrapped" ]; then
    # Plaintext made for the restore (the decrypted archive, the unpacked ClickHouse backup) is removed on exit.
    trap 'rm -rf "$dir/.restore-$PG_FILE" "$dir/$CH_DIR"' EXIT
  fi
  if [ "$clickhouse_only" = false ]; then
    if [ -n "$wrapped" ]; then
      # Decrypted beside the set for the restore only (pg_restore seeks in a custom archive).
      open_file "$pg_file" "$(manifest_value postgres iv)" > "$dir/.restore-$PG_FILE"
      pg_file="$dir/.restore-$PG_FILE"
    fi
    # --no-table-access-method: tables take the target's default (tde_heap on an encrypted server, ADR-067).
    pg_restore --clean --if-exists --no-owner --no-privileges --no-table-access-method --single-transaction \
      --dbname="$target_url" "$pg_file"
    # pg_restore carries no planner statistics; until autovacuum gathers them the first queries plan blind.
    psql "$target_url" -qc 'ANALYZE' > /dev/null
    log "postgres restored" "$name"
  fi
  if [ "$postgres_only" = true ]; then
    log "restore complete (postgres only)" "$name"
    return
  fi
  if [ -n "$wrapped" ]; then
    open_file "$dir/$(manifest_value clickhouse archive)" "$(manifest_value clickhouse iv)" | tar -C "$dir" -xf -
    chown -R "$CLICKHOUSE_UID" "$dir/$CH_DIR"
  fi
  ch "DROP DATABASE IF EXISTS $target_db SYNC" > /dev/null
  ch "RESTORE DATABASE $source_db AS $target_db FROM File('$name/$CH_DIR')" > /dev/null
  log "clickhouse restored" "$name"
  log "restore complete; rebuild Memgraph and Meilisearch with the reconciler's reproject" "$name"
}

# The set directories, newest first by the manifest's createdAt: a set may carry any name (`create pre-upgrade`), so the
# directory name says nothing about its age.
sets_newest_first() {
  for m in "$BACKUP_DIR"/*/; do
    [ -f "$m$MANIFEST" ] || continue
    at=$(sed -n 's/.*"createdAt":"\([^"]*\)".*/\1/p' "$m$MANIFEST" | head -n 1)
    printf '%s %s\n' "${at:-0}" "$m"
  done | LC_ALL=C sort -r | cut -d' ' -f2-
}

list() {
  for m in $(sets_newest_first); do
    cat "$m$MANIFEST"
  done
  return 0
}

prune() {
  kept=0
  for m in $(sets_newest_first); do
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
