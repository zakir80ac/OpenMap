# REQ-SEC-011 REQ-INT-019 (ADR-067) — the backup service may take a Raft snapshot and nothing else.
path "sys/storage/raft/snapshot" {
  capabilities = ["read"]
}
