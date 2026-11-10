# REQ-SEC-011 (ADR-067) — what the API, scheduler and BSM engine may do: integration and discovery credentials under the
# KV v2 mount (OPENBAO_MOUNT, "openmap" by default) and field encryption with the openmap-fields Transit key. Nothing else.
path "openmap/data/*" {
  capabilities = ["create", "read", "update"]
}

path "openmap/metadata/*" {
  capabilities = ["read", "list"]
}

path "transit/encrypt/openmap-fields" {
  capabilities = ["update"]
}

path "transit/decrypt/openmap-fields" {
  capabilities = ["update"]
}
