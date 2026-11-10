# REQ-SEC-011 (ADR-067) — PostgreSQL's pg_tde key provider: its principal keys under the `tde` KV v2 mount, and the
# mount's own description (pg_tde reads it to check the KV version). Nothing else.
path "tde/data/*" {
  capabilities = ["create", "read", "update", "list"]
}

path "tde/metadata/*" {
  capabilities = ["read", "list"]
}

path "sys/mounts/tde" {
  capabilities = ["read"]
}
