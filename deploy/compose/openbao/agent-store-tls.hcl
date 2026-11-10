# REQ-SEC-011 (ADR-068) — OpenBao Agent beside a store whose image carries none (Valkey, Memgraph, Meilisearch). It logs
# in with the store-tls AppRole and keeps the store's server certificate and key in one PEM, from the internal services
# CA, renewed before it expires, on a memory volume shared with the store only. It runs as the user the store runs as.
#
#   TLS_NAME  the name clients connect to (the compose service or Kubernetes Service name)
#   TLS_TTL   the certificate's lifetime: 720h, except Memgraph (8760h), which restarts to take a new one
#
# The key is PKCS#8 (Meilisearch reads no other EC key format). How each store takes a renewed certificate:
#   Valkey       its wrapper sees the change and points Valkey at it with CONFIG SET (no restart);
#   Meilisearch  its wrapper restarts it (seconds);
#   Memgraph     its wrapper restarts it, which reloads the graph from its snapshot (minutes), hence the year.
# OpenBao's address comes from BAO_ADDR.
pid_file = "/tmp/agent.pid"

auto_auth {
  method "approle" {
    config = {
      role_id_file_path                   = "/openbao/approle-store/role-id"
      secret_id_file_path                 = "/openbao/approle-store/secret-id"
      remove_secret_id_file_after_reading = false
    }
  }
}

template {
  destination = "/run/store-tls/tls.pem"
  perms       = "0600"
  contents    = "{{ with pkiCert \"pki/issue/openmap-services\" (printf \"common_name=%s\" (env \"TLS_NAME\")) \"alt_names=localhost\" \"private_key_format=pkcs8\" (printf \"ttl=%s\" (env \"TLS_TTL\")) }}{{ .Cert }}{{ .Key }}{{ end }}"
}
