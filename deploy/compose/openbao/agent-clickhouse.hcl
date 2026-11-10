# REQ-SEC-011 (ADR-067 step 6) — OpenBao Agent beside ClickHouse: logs in with the clickhouse-disk AppRole and writes the
# encrypted disk's key (64 hex characters, from tde/clickhouse-disk) to a memory-backed volume ClickHouse reads at start.
# The key never reaches a disk; ClickHouse takes it into the encrypted disk's configuration through an environment
# variable set by its entrypoint wrapper. OpenBao's address comes from BAO_ADDR.
pid_file = "/tmp/agent.pid"

auto_auth {
  method "approle" {
    config = {
      role_id_file_path                   = "/openbao/approle-clickhouse/role-id"
      secret_id_file_path                 = "/openbao/approle-clickhouse/secret-id"
      remove_secret_id_file_after_reading = false
    }
  }
}

template {
  destination = "/run/clickhouse-key/key"
  perms       = "0440"
  contents    = "{{ with secret \"tde/data/clickhouse-disk\" }}{{ .Data.data.key }}{{ end }}"
}

# ADR-068 — ClickHouse's server certificate and key in one PEM, from the internal services CA, renewed before it expires;
# ClickHouse reloads a changed certificate file. TLS_COMMON_NAME is the name clients connect to.
template {
  destination = "/run/clickhouse-key/tls.pem"
  perms       = "0600"
  contents    = "{{ with pkiCert \"pki/issue/openmap-services\" (printf \"common_name=%s\" (env \"TLS_COMMON_NAME\")) \"alt_names=localhost\" \"ip_sans=127.0.0.1\" \"ttl=720h\" }}{{ .Cert }}{{ .Key }}{{ end }}"
}
