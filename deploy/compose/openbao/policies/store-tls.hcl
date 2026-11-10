# REQ-SEC-011 (ADR-068) — the OpenBao Agents beside Valkey, Memgraph and Meilisearch issue their stores' server
# certificates from the internal services CA, and can do nothing else.
path "pki/issue/openmap-services" {
  capabilities = ["update"]
}
