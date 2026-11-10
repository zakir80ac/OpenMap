# REQ-SEC-011 (ADR-067 step 6) — the OpenBao Agent beside ClickHouse reads the encrypted disk's key and nothing else.
path "tde/data/clickhouse-disk" {
  capabilities = ["read"]
}

# ADR-068: the agent issues ClickHouse's server certificate from the internal services CA.
path "pki/issue/openmap-services" {
  capabilities = ["update"]
}
