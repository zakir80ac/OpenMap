# REQ-SEC-011 REQ-INT-019 (ADR-067) — the backup service may take a Raft snapshot, and (step 5) ask Transit for a data
# key per backup set and unwrap it again for verify and restore. The key `openmap-backup` itself never leaves OpenBao.
path "sys/storage/raft/snapshot" {
  capabilities = ["read"]
}

path "transit/datakey/plaintext/openmap-backup" {
  capabilities = ["update"]
}

path "transit/decrypt/openmap-backup" {
  capabilities = ["update"]
}
