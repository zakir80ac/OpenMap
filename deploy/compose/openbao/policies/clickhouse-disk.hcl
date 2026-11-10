# REQ-SEC-011 (ADR-067 step 6) — the OpenBao Agent beside ClickHouse reads the encrypted disk's key and nothing else.
path "tde/data/clickhouse-disk" {
  capabilities = ["read"]
}
