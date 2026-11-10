# REQ-SEC-011 (ADR-067) — OpenBao in server mode for the single-node stack: Raft storage on its own volume, auto-unseal
# with the static key seal (a 32-byte key generated once by openbao-keys into its own volume; use the pkcs11 or kmip seal
# where a deployment has an HSM or a KMS), Prometheus metrics without a token.
#
# ADR-068: the listener serves TLS only, from /openbao/tls/tls.pem (certificate and key in one file). On the first start
# that is the bootstrap certificate openbao-keys made (its CA is in the services CA bundle); from then on the
# openbao-certs agent keeps a certificate from OpenBao's own internal services CA there and sends SIGHUP, on which
# OpenBao reloads it.
ui            = false
disable_mlock = true
api_addr      = "https://openbao:8200"
cluster_addr  = "https://openbao:8201"

storage "raft" {
  path    = "/openbao/data"
  node_id = "openbao-1"
}

listener "tcp" {
  address         = "0.0.0.0:8200"
  tls_cert_file   = "/openbao/tls/tls.pem"
  tls_key_file    = "/openbao/tls/tls.pem"
  tls_min_version = "tls12"
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
