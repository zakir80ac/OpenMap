# REQ-SEC-011 (ADR-067) — OpenBao Agent beside PostgreSQL: logs in with the pg-tde AppRole and keeps a valid token in
# the file pg_tde's key provider reads (secret_token_path), renewing it before it expires and logging in again when it
# cannot. PostgreSQL never holds a long-lived token.
pid_file = "/tmp/agent.pid"

vault {
  address = "http://openbao:8200"
}

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
