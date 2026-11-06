# Certificate inventory and expiry alerts (REQ-CMDB-032)

Captured 2026-11-06 on the dev compose stack. Decision: ADR-036.

## What changed

1. **Contract** (`packages/contracts/src/certificate.ts`): the attribute names the certificate collector writes; days
   left from `notAfter` (rounded down, never the collector's stale count); the alert threshold reached (smallest of
   60, 30, 14, 7 and 1 days at or above, 0 once expired); short keys and weak signature hashes under the deployment's
   key policy (`CERTIFICATES`); the `openmap.certificate.expiring` data (event 0.9.0).
2. **Storage** (migration 0024): `certificate_alerts`, one row per certificate, expiry date and threshold.
3. **BSM engine**: every `CERTIFICATES.checkEveryMs` the watcher raises each threshold a certificate reaches once:
   the alert row and its outbox event in one transaction, guarded by the unique key; Prometheus counter
   `openmap_bsm_certificate_alerts_total` and span `bsm.check_certificates`.
4. **API** (GraphQL 1.14.0): `certificates(filter)` soonest expiry first, with days left, weaknesses, SANs, the TLS
   endpoints each secures, the issuing certificate and the last alert; certificate authorities only on request.
5. **Console**: a Certificates screen under Insight with headline counts and the filters.

## Tests

| Id | What | Result |
| --- | --- | --- |
| T-186 | `packages/contracts/src/certificate.test.ts`: days left, thresholds, weak keys and signatures, the alert data | 3 of 3 |
| T-187 | `apps/bsm-engine/src/service/certificates.test.ts`: planning: far out raises nothing, inside a threshold raises that one only, raised once, expired raises 0, unreadable dates skipped, endpoints carried | 1 of 1 (suite 46 of 46) |
| T-188 | `apps/bsm-engine/src/service/certificates.integration.test.ts`: against Postgres, a certificate behind two endpoints expiring in five days raises one 7-day alert with its outbox event, an expired one raises 0, a far one nothing; a second check raises nothing more | 1 of 1 |
| T-189 | `apps/api/src/api.integration.test.ts`: the register with days left, weaknesses, SANs, endpoint, issuer and last alert; authorities on request; horizon, weak and text filters | 1 of 1 (suite 28 of 28) |
| T-190 | `apps/console/src/components/certificates/CertificatesView.test.tsx` (en, ar): helpers; the register's names, days left, expired, weakness tags, endpoint and issuer links, alerts; filters reach the query | 3 of 3 |
| T-191 | Playwright `apps/console/e2e/certificates.spec.ts` (en, ar): two certificates imported through the pipeline, listed soonest expiry first with days left and the weak signature; the weak filter keeps one | 2 of 2 |

## Screenshots

- `console/certificates-en.png`, `console/certificates-ar.png`: the inventory with the imported certificates.
