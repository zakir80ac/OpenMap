# ADR-006 — `@peculiar/x509` for Node certificate issuance

Status: Proposed (awaiting Syed) · Date: 2026-10-22 · Tracker: REQ-SEC-004, REQ-DISC-031

## Context

Discovery Nodes authenticate to the scheduler with mTLS (CLAUDE.md §5). Enrolment hands a one-time token and a CSR to the scheduler, which must sign a client certificate from the internal CA. Node.js `node:crypto` can parse certificates but cannot create or sign X.509 certificates, and shelling out to `openssl` would make the scheduler depend on a binary outside the compose image.

## Decision

Use `@peculiar/x509` (MIT, pure TypeScript over WebCrypto) in `apps/scheduler` for CSR parsing, certificate generation and thumbprints. Keys are ECDSA P-256, signatures SHA-256, serials 16 random bytes. The CA private key lives on the scheduler host at `SCHEDULER_CA_KEY_PATH`; issued certificates carry the clientAuth EKU and a configurable validity (`NODE_CERT_VALIDITY_DAYS`, default 90). `pnpm --filter @openmap/scheduler pki:init` bootstraps a CA and server certificate for a fresh deployment.

## Alternatives considered

- `openssl` subprocess: works everywhere but adds an image dependency and shell quoting risk.
- step-ca or a Vault/OpenBao PKI engine: better long term for rotation and CRLs; OpenBao's PKI secrets engine is the natural upgrade path and keeps the same enrolment API. Deferred until the single-node release is stable.

## Consequences

One new runtime dependency, not in SPEC.md's component table, hence this ADR. The library is sovereign (no network calls) and air-gap safe.
