# Compliance posture per framework (REQ-SEC-012, ADR-070)

Captured 2026-11-10 on the dev compose stack (Postgres TLS-only), migration `0047_compliance_posture` applied with
`pnpm --filter @openmap/db migrate:postgres`. The API code ran from the branch build on the Windows host
(`ComplianceService.evaluate` through the full `AppModule`); the compose API image was not rebuilt.

## Evaluations of the two dev tenants

| Tenant                                  | CIs     | Facts gathered (subjects)                                                                                                                        | Decisions stored | Gather + checks | Total with storing | `compliancePosture` | `complianceControl` (ISO A.8.8, fail, 50) |
| --------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | --------------- | ------------------ | ------------------- | ----------------------------------------- |
| dev `ac9a6a65` (seed 42, scale 0.05)    | 32,886  | 2,147 CIs with software, 2,000 OS, 2,387 releases, 4,640 assets, 20 certificates, 20 stores, 1 bucket, 34 databases, 8 firewalls, the deployment | 13,425           | 424 ms          | 816 ms             | 4 ms                | 12 ms                                     |
| scale-1 `570b1953` (seed 43, scale 1)   | 550,818 | 42,476 CIs with software, 40,000 OS, 47,749 releases, 90,697 assets, 371 stores, 4 shares, 10 buckets, 541 databases, 12 firewalls, the deployment | 264,337          | 17.4 s          | 23.2 s             | 4 ms                | 85 ms                                     |

Per fact family on scale-1 (separate profile run): exposure 3.7 s, asset register 1.6 s, lifecycle releases 1.4 s,
operating systems 0.3 s, every other family under 0.25 s. The rest of the 17 s is the shared stack's load at the time
(four agents and a second compose stack were running integration tests).

### Posture of the dev tenant (run `bd09f864`, catalogue 2026.11.1)

CVE risk: 0 critical, 6 high, 1 exploited distinct CVEs; 1,533 CIs carry a high or critical CVE.

| Framework | Pass rate | Passed / failed / n/a | High-risk CIs | Controls (result passed/failed/n/a)                                                                                    |
| --------- | --------- | --------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| SOC 2     | 63.5 %    | 5,425 / 3,113 / 4,887 | 1,533         | CC6.1 pass 21/0/0 · CC6.6 fail 7/2/0 · CC6.7 fail 20/20/0 · CC6.8 fail 1845/302/0 · CC7.1 fail 3523/2754/257 · A1.2 fail 10/35/4630 |
| ISO 27001 | 63.5 %    | 5,425 / 3,113 / 4,887 | 1,533         | A.7.13 pass · A.8.3 pass · A.8.8 fail 5368/3056/257 · A.8.13 fail 0/35/0 · A.8.20 fail 6/2/0 · A.8.24 fail 40/20/0       |
| PCI DSS   | 63.8 %    | 5,425 / 3,078 / 4,887 | 1,533         | 1.3 fail · 3.5 pass · 4.2.1 fail 20/20/0 · 6.3.3 fail 2668/1479/0 · 11.3.1 fail 614/1533/0 · 12.3.4 fail 2096/44/4887   |
| SAMA CSF  | 63.8 %    | 5,425 / 3,078 / 4,887 | 1,533         | 3.3.8 fail 2103/46/4887 · 3.3.9 fail 40/20/0 · 3.3.17 fail 3282/3012/0                                                  |
| NCA ECC   | 63.5 %    | 5,425 / 3,113 / 4,887 | 1,533         | 2-3 fail · 2-5 fail 6/2/0 · 2-7 pass · 2-8 fail 40/20/0 · 2-9 fail 0/35/0 · 2-10 fail 2459/1835/0                       |

Decisions by check: `cve_high_critical` 1,533 fail / 614 pass; `cve_exploited` 302 fail / 1,845 pass; `os_patched`
1,177 fail / 823 pass; `release_supported` 44 fail / 2,086 pass / 257 n/a; `hardware_supported` 10 pass / 4,630 n/a (no
end-of-support date recorded); `certificate_valid` and `certificate_strong` 10 fail / 10 pass each; `storage_encrypted`
20 pass; `bucket_public_blocked` 1 pass; `database_backup_recent` 34 fail (backup times are those of the generation
run); `firewall_no_permissive` 2 fail / 6 pass; `platform_backup_recent` 1 fail (the host run had no `BACKUP_DIR`).
No TLS listener in the estate reports a negotiated version, so `tls_modern` decided nothing.

The first finding of ISO A.8.8 (high-risk first): `cve_high_critical` fail, reason `high_cve`, facts
`worstCve=CVE-2026-1923, worstCvss=7.7, highOrCritical=1, critical=0, installed=1`, high risk.

### Scale-1 tenant (run `510f814a`)

CVE risk: 25 critical, 67 high, 33 exploited distinct CVEs; all 42,476 CIs with software carry a high or critical one,
so every framework has 42,476 high-risk CIs. Pass rates: SOC 2 35.4 %, ISO 27001 35.4 %, PCI DSS 35.6 %, SAMA CSF
35.6 %, NCA ECC 35.4 %. `release_supported` 371 fail / 42,804 pass / 4,574 n/a; `os_patched` 23,286 fail / 16,714 pass;
`storage_encrypted` 371 pass; `share_encrypted` 4 fail; `bucket_public_blocked` 10 pass; `firewall_no_permissive` 12
pass; `database_backup_recent` 541 fail; `hardware_supported` 90,697 n/a.

## Tests

| Test                                                                         | What it proves                                                                                                                                                                                                                                                                                                                       | Result |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `packages/contracts/src/compliance.test.ts` (T-600)                          | the catalogue covers every framework with distinct control ids and uses every check; each check's pass, fail and not-applicable boundaries (CVE severity and CVSS, release state, patch window, hardware date, certificate expiry and key, TLS ranks, storage, share and bucket attributes, database and deployment backups, firewall); pass rate, control results and high-risk CIs from outcomes; no pass rate when nothing was decided; distinct CVE risk | 13 passed |
| `apps/api/src/compliance/compliance.service.test.ts` (T-601)                 | `assess()`: every fact family becomes outcomes, an OS failure counts against its host, the deployment's backup is one subject, the high-risk flag marks only failures on exposed CIs                                                                                                                                                  | 2 passed |
| `apps/api/src/compliance/compliance.integration.test.ts` (T-602)             | against the compose stack in a tenant of its own with one fact of every family: no posture before the first run; the evaluation stores the expected decision, reason and facts per check and subject; pass rate = passed / (passed + failed) per framework; host A is the single high-risk CI; a control's findings come high-risk first; analysts read but may not evaluate, auditors may; an unknown control is refused | 2 passed (8.4 s) |
| `apps/console/src/components/assets/CompliancePosture.test.tsx` (T-603)      | en and ar: before a run operators get "Evaluate now" and analysts a read-only note; after it the CVE tiles, five framework cards with pass rate tone and high-risk CIs, the controls of the selected framework, a control's findings with reason, translated fact labels, high-risk tag and the deployment subject, the result filter; the tab is the Assets screen's `?tab=posture` | 7 passed |
| `apps/console/src/components/assets/AssetsView.test.tsx` (T-100, unchanged)  | the register behind the new tab strip                                                                                                                                                                                                                                                                                                 | 24 passed |
| `apps/console/e2e/compliance-posture.spec.ts` (T-604)                        | on the live stack, per locale: the tab from the register, an evaluation, five cards with pass rate and high-risk CIs, ISO A.8.8 failing with a high-risk finding linked to its CI; screenshots `compliance-posture-{en,ar}.png`, `compliance-findings-{en,ar}.png` | written, not run (the compose API and console images were not rebuilt) |

The integration test passed in 3 of 8 runs on 2026-11-10; the other runs failed before the first assertion with
`Can't reach database server at localhost:5432` or a Prisma pool timeout while the API module started, the same
failure the existing T-504 anomaly integration test showed in the same window. Docker Desktop's port forwarding was
dropping connection bursts while a second compose stack (`omtls-*`) and other agents' tests were running; the test now
writes its estate before the API starts so its own burst does not coincide with the API's.

Also run: `pnpm guard` ok; `pnpm contracts:check` (GraphQL 1.42.0 ok against HEAD); typecheck of contracts, db, api and
console; `pnpm --filter @openmap/console lint`; unit suites of contracts (123), db (91), i18n (6), api (56) and console
(391), all passing.
