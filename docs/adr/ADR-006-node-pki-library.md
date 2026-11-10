# ADR-006 — `@peculiar/x509` for Node certificate issuance

Status: Accepted (Syed, 2026-11-10: "finish SEC-011, closing PERF-002 and PERF-004, and the 11 P1 rows", the rows including REQ-SEC-013, this ADR's acceptance) · Proposed 2026-10-22 · Tracker: REQ-SEC-004, REQ-DISC-031, REQ-SEC-013

## Context

Discovery Nodes authenticate to the scheduler with mTLS (CLAUDE.md §5). Enrolment hands a one-time token and a CSR to the scheduler, which must sign a client certificate from the internal CA. Node.js `node:crypto` can parse certificates but cannot create or sign X.509 certificates, and shelling out to `openssl` would make the scheduler depend on a binary outside the compose image.

## Decision

Use `@peculiar/x509` (MIT, pure TypeScript over WebCrypto) in `apps/scheduler` for CSR parsing, certificate generation and thumbprints. Keys are ECDSA P-256, signatures SHA-256, serials 16 random bytes. The CA private key lives on the scheduler host at `SCHEDULER_CA_KEY_PATH`; issued certificates carry the clientAuth EKU and a configurable validity (`NODE_CERT_VALIDITY_DAYS`, default 90). `pnpm --filter @openmap/scheduler pki:init` bootstraps a CA and server certificate for a fresh deployment.

## Alternatives considered

- `openssl` subprocess: works everywhere but adds an image dependency and shell quoting risk.
- step-ca or a Vault/OpenBao PKI engine: better long term for rotation and CRLs; OpenBao's PKI secrets engine is the natural upgrade path and keeps the same enrolment API. Deferred until the single-node release is stable.

## Consequences

One new runtime dependency, not in SPEC.md's component table, hence this ADR. The library is sovereign (no network calls) and air-gap safe.

## Note (2026-11-10)

ADR-068 put a PKI engine in OpenBao for the service certificates of the stores. The Node CA stays in the scheduler
under this ADR: Nodes enrol from the field with a one-time token, and the scheduler signs their client certificate.
Moving that issuance to OpenBao's PKI engine remains the upgrade path named above; it is not part of this decision.
