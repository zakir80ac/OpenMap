# REQ-SEC-011 (ADR-068) — OpenBao Agent beside OpenBao itself: replaces the bootstrap certificate of OpenBao's listener
# (openbao-keys) with one from the internal services CA, and renews it before it expires. It runs as OpenBao's user in
# OpenBao's process namespace; after each render it sends SIGHUP to the server (PID 1 there), on which OpenBao reloads the
# listener's certificate without dropping its seal state. Certificate and key in one PEM, as the listener reads them.
# The agent renders to issued.pem and copies it over tls.pem, the file the listener reads: the first render replaces the
# bootstrap certificate there, whatever the agent makes of the file it finds at start.
#
#   TLS_NAME  the name clients connect to (compose service or Kubernetes Service name)
#   TLS_TTL   the certificate's lifetime
# OpenBao's address comes from BAO_ADDR, its CA bundle from BAO_CACERT.
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
  destination = "/openbao/tls/issued.pem"
  perms       = "0600"
  contents    = "{{ with pkiCert \"pki/issue/openmap-services\" (printf \"common_name=%s\" (env \"TLS_NAME\")) \"alt_names=localhost\" \"ip_sans=127.0.0.1\" (printf \"ttl=%s\" (env \"TLS_TTL\")) }}{{ .Cert }}{{ .Key }}{{ end }}"
  exec {
    command = ["sh", "-c", "cp /openbao/tls/issued.pem /openbao/tls/tls.pem.new && mv -f /openbao/tls/tls.pem.new /openbao/tls/tls.pem && kill -HUP 1"]
  }
}
