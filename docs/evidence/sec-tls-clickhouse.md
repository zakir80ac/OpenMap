# TLS to ClickHouse (REQ-SEC-011, ADR-068 store 2 of 6)

Captured 2026-11-10 on the dev compose stack.

## What runs

- **Ports.** `clickhouse/tls.xml`: HTTPS on 8443 and the secure native protocol on 9440. The plain HTTP (8123),
  native (9000), interserver, MySQL and PostgreSQL ports are removed. TLS 1.2 minimum.
- **The certificate.** Issued by the internal services CA through `clickhouse-keys` (a `pkiCert` template; one PEM,
  uid 101, 30 days, `CN=clickhouse`, SAN `localhost`) into the memory volume that already holds the disk key, and
  renewed before it expires.
- **Clients verify the server** against `SERVICE_CA_PATH`:
  - every Node client goes through `clickhouseOptions` (`@openmap/db`, T-582): API, reconciler dispatcher, BSM engine,
    migrations, integration tests;
  - the backup script's `curl` uses `--cacert $CLICKHOUSE_CA`;
  - Superset's `clickhouse-connect` URI carries `secure=true&verify=true&ca_cert=…`. The API now updates an existing
    Superset database registration on every provisioning, so a change of TLS or credentials reaches Superset.
- **Unchanged:** Prometheus' metrics port (9363) carries no data and stays on the internal network.
- **Helm:** the same, with the CA fetched by an init container; the Service exposes 8443 and 9440, and readiness
  probes `/ping` over HTTPS.

## Checks

| Check | Result |
| --- | --- |
| `http://clickhouse:8123/ping` from the compose network | refused (port closed) |
| `clickhouse:9000` (plain native) | refused (port closed) |
| `https://clickhouse:8443/ping` with `--cacert services-ca.crt` | `Ok.`, TLS 1.3, `subject: CN=clickhouse`, `issuer: CN=OpenMap Internal Services CA` |
| `https://clickhouse:8443/ping` without the CA | refused (unknown issuer) |
| Migrations over HTTPS | nothing to apply, no error |
| Outbox | nothing pending for ClickHouse after the switch |
| Telemetry fleet p95 (API reads from ClickHouse), 138k-CI tenant | 57 ms (budget 100) |
| Superset → ClickHouse over verified HTTPS (`clickhouse_connect` and SQLAlchemy inside the Superset container) | `count() FROM ci_history` = 751,589; `SELECT 1` |
| Playwright: screens, services, telemetry, utilisation, power monitor (en, ar) | 21 passed, 6 failed in the joint run. Each failed test passed when re-run; the failures varied by locale between runs (a sign-in page that never loaded, a Superset embed through localhost). The cause is the host's port forwarding dropping connection bursts (`sec-tls-postgres.md`) |
