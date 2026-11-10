# REQ-SEC-011 (ADR-067) — OpenBao Agent beside PostgreSQL: logs in with the pg-tde AppRole and keeps a valid token in
# the file pg_tde's key provider reads (secret_token_path), renewing it before it expires and logging in again when it
# cannot. PostgreSQL never holds a long-lived token.
# OpenBao's address comes from BAO_ADDR (compose and Helm set it), so one file serves both.
pid_file = "/tmp/agent.pid"

auto_auth {
  method "approle" {
    config = {
      role_id_file_path                   = "/openbao/approle-pgtde/role-id"
      secret_id_file_path                 = "/openbao/approle-pgtde/secret-id"
      remove_secret_id_file_after_reading = false
    }
  }

  sink "file" {
    config = {
      path = "/run/pgtde/token"
      mode = 0440
    }
  }
}

# ADR-068 — PostgreSQL's server certificate and key in one PEM (PostgreSQL reads the certificate and the key from it),
# from the internal services CA, renewed before it expires; on each renewal the postmaster is told to reload (the agent
# shares PostgreSQL's process namespace and user). TLS_COMMON_NAME is the name clients connect to.
template {
  destination = "/run/pgtde/tls.pem"
  perms       = "0600"
  contents    = "{{ with pkiCert \"pki/issue/openmap-services\" (printf \"common_name=%s\" (env \"TLS_COMMON_NAME\")) \"alt_names=localhost\" \"ip_sans=127.0.0.1\" \"ttl=720h\" }}{{ .Cert }}{{ .Key }}{{ end }}"
  exec {
    command = ["sh", "-c", "pkill -HUP -o -x postgres || true"]
  }
}
