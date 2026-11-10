# ADR-070 — Compliance posture per framework, computed from stored facts

Status: Accepted · Date: 2026-11-10 · Tracker: REQ-SEC-012 · Contracts: GraphQL 1.42.0 · Migration: 0047_compliance_posture

## Context

DESIGN-CUES.md adopts a compliance tab beside the asset and warranty register: posture per regulatory framework (SOC 2,
ISO 27001, PCI DSS, and for OpenMap's market SAMA CSF and NCA ECC) with CVE risk and an audit pass rate. REQ-SEC-012
asks for controls mapped to CIs, the tab on the Assets screen, and the pass rate and high-risk CI count computed from
evidence. OpenMap already holds the evidence an auditor asks for: CVE correlation (software → affected_by →
vulnerability, ADR-013), the lifecycle catalogue (ADR-039), end of support in the asset register (ADR-023), certificates
(ADR-036), TLS listeners, encryption and public-access attributes from the storage and object store collectors, database
backup times, firewall rule analysis (ADR-064) and the deployment's own backup manifests (ADR-066).

## Decision

1. **The catalogue is data, versioned in the contracts.** `packages/contracts/src/compliance.ts` lists five frameworks
   (`soc2`, `iso27001`, `pci_dss`, `sama_csf`, `nca_ecc`), each with its edition and the controls OpenMap can evidence
   automatically, by control identifier only. Each control names the checks that decide it. Titles are i18n keys
   (`assets.compliance.control.<framework>.<id>`), short paraphrases in English and Arabic; no text of any standard is
   reproduced. `COMPLIANCE_CATALOGUE_VERSION` is bumped with every change to a framework, control or mapping, and each
   stored evaluation records the version it used.
2. **Only controls with an automated check are in the catalogue.** A control that OpenMap cannot decide from stored
   facts (policy, training, identity governance: MFA and RBAC live in Keycloak, not in the CMDB) is left out rather than
   shown as passing or as a manual placeholder row. The tab therefore reports technical posture, not certification.
3. **Fourteen checks, pure functions over facts.** Each returns `pass`, `fail` or `not_applicable` with a reason
   (`COMPLIANCE_REASONS`, each an i18n sentence) and the facts that decided it:
   `cve_high_critical`, `cve_exploited` (CIs with discovered software; a CVE is high risk by severity, or unlabelled from
   `COMPLIANCE.highRiskCvss`), `release_supported` (OS, hypervisor and network OS against the catalogue; unknown
   releases are not applicable), `os_patched` (`LIFECYCLE.patchStaleDays`), `hardware_supported` (asset register end of
   support), `certificate_valid` and `certificate_strong` (CERTIFICATES' key policy), `tls_modern`
   (`COMPLIANCE.minTlsVersion`), `storage_encrypted` (`encryptionAtRest` or an object store's `encryption`),
   `share_encrypted` (SMB encryption, NFS `sec=krb5p`), `bucket_public_blocked`, `database_backup_recent`
   (`COMPLIANCE.databaseBackupMaxAgeHours`), `platform_backup_recent` (this deployment's newest complete, encrypted
   backup set; none fails) and `firewall_no_permissive`. Missing evidence is `not_applicable`, never `pass`.
4. **Posture from the outcomes.** Per framework: the pass rate is passed / (passed + failed) over its evaluations
   (a check shared by two controls counts once), null when nothing was decided; a control fails on any failure, passes
   when one passes and none fails; the high-risk CIs are those failing any of the framework's controls that carry a high
   or critical CVE, where an operating system's failures count against the host it is installed on. CVE risk counts
   distinct critical, high and exploited CVEs and the CIs exposed to a high or critical one.
5. **Evaluations are stored as evidence.** `Mutation.evaluateCompliance` (operators and auditors; audited like every
   mutation) gathers the facts one family after another (an evaluation must not take the pool from interactive reads),
   runs the checks, and stores in one transaction a `compliance_runs` row (summary = the posture) and one
   `compliance_results` row per check and subject with its reason, facts and high-risk flag, `COMPLIANCE.insertBatch`
   rows per `unnest` insert. The newest `COMPLIANCE.keepRuns` runs per tenant are kept. `ciId` is not a foreign key, so
   evidence stays as it was when a CI later goes away. Reads serve the latest run: `compliancePosture` from its summary
   and `complianceControl` from its results, failing high-risk CIs first.
6. **On the Assets screen.** A second tab (`?tab=posture`) shows the CVE risk, a card per framework (pass rate, control
   counts, high-risk CIs), the selected framework's controls and a control's decisions with CI, reason and facts.
7. **Observability.** Spans `compliance.evaluate`, `compliance.posture`, `compliance.control`; metrics
   `openmap_compliance_evaluations_total{outcome}`, `openmap_compliance_evaluation_seconds` and
   `openmap_compliance_results_total{check,result}`.

## Consequences

- The posture is as good as discovery: a CI without the fact a check reads is not applicable and the counts say so.
  On the synthetic estate most asset records carry no end-of-support date, so `hardware_supported` is mostly not
  applicable, and database backup times are those of the generation run, so they fail as stale.
- Every framework includes the CVE check, so every CI with a high or critical CVE is a high-risk CI of every framework;
  the per-framework count differs only where a framework evaluates no CVE check.
- An evaluation of a 100k-CI estate reads about 8 s of facts and writes a few hundred thousand result rows; it runs on
  demand, not on every read (measured in docs/evidence/sec-compliance-posture.md).
- Adding a framework or control is a catalogue change (version bump, i18n keys in both locales, an enum member in the
  GraphQL contract for a new framework).
