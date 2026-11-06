# ADR-036 — Certificate inventory and expiry alerts

Status: Accepted and implemented (REQ-CMDB-032, 2026-11-06) · Date: 2026-11-06 · Tracker: REQ-CMDB-032

## Context

Device42 inventories TLS certificates and warns before they expire (CAPABILITY-MAP §2). OpenMap's certificate
collector already reports each certificate on a TLS endpoint as a `certificate` CI (identity: SHA-256 fingerprint;
subject, issuer, validity, key, signature, SANs), the endpoint as a `listening_service` that is `secured_by` its
leaf, and the chain as `depends_on` links. Nothing read them, and the collector's own `daysToExpiry` goes stale between
sweeps.

## Decision

1. **Days left come from `notAfter`, at read time.** `certificateDaysLeft` in the contract (rounded down) is the
   single rule for the register and the watcher; `certificateWeaknesses` flags a short key (RSA under
   `CERTIFICATES.minRsaBits`, EC under `minEcBits`) and a weak signature hash (`weakSignatures`).
2. **The register** (GraphQL 1.14.0 `certificates(filter)`) lists certificates soonest expiry first with days left,
   expiry, weaknesses, SANs, the endpoints each secures, the issuing certificate and the last alert raised; filters by
   horizon, expired, self-signed, weak and text. Certificate authorities in discovered chains are left out unless
   asked for.
3. **Alerts are raised once per threshold.** The BSM engine checks every `CERTIFICATES.checkEveryMs`; a certificate
   that has reached a threshold of `alertThresholdsDays` (60, 30, 14, 7, 1), or expired (threshold 0), raises
   `openmap.certificate.expiring` (event 0.9.0) with the subject, expiry, days left, threshold and endpoint count.
   The alert row (`certificate_alerts`, migration 0024, unique per certificate, expiry and threshold) and its outbox
   event are written in one transaction, so a restart or a second engine never raises it twice. A certificate first
   seen inside a threshold raises that threshold only. A renewed certificate is a new CI and starts afresh. The event
   reaches integrations and notifications through the outbox like every other.
4. **The console** has a Certificates screen under Insight with headline counts (total, expiring within 30 days,
   expired, weak, self-signed).

## Consequences

- Certificate renewal is visible and alerted from discovery alone; no separate certificate manager is needed.
- Thresholds, check interval and key policy are deployment constants, not code.
