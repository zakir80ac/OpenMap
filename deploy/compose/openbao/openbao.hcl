# REQ-SEC-011 (ADR-067) — OpenBao in server mode for the single-node stack: Raft storage on its own volume, auto-unseal
# with the static key seal (a 32-byte key generated once by openbao-keys into its own volume; use the pkcs11 or kmip seal
# where a deployment has an HSM or a KMS), Prometheus metrics without a token. TLS on this listener comes with the
# in-transit work (the internal CA issues OpenBao's certificate).
ui            = false
disable_mlock = true
api_addr      = "http://openbao:8200"
cluster_addr  = "http://openbao:8201"

storage "raft" {
  path    = "/openbao/data"
  node_id = "openbao-1"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
  telemetry {
    unauthenticated_metrics_access = true
  }
}

seal "static" {
  current_key_id = "compose-1"
  current_key    = "file:///openbao/unseal/unseal.key"
}

telemetry {
  prometheus_retention_time = "24h"
  disable_hostname          = true
}
