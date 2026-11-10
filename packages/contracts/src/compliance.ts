// REQ-SEC-012 (ADR-070) — compliance posture per framework. The catalogue is data: each framework lists the controls
// OpenMap can evidence automatically, by control identifier only (titles are i18n keys, paraphrased, never the
// standard's text), and each control names the checks that decide it. A check is a pure function over facts OpenMap
// already stores (CVE correlation, the lifecycle catalogue, the asset register, certificates, TLS listeners, storage
// and share attributes, database backups, the deployment's own backups, firewall analysis); each returns pass, fail
// or not_applicable with the facts that decided it. The posture of a framework is computed from those outcomes:
// pass rate = passed / (passed + failed) over its evaluations, and the high-risk CIs are those failing any of its
// controls that carry a high or critical CVE.
import { COMPLIANCE, LIFECYCLE, TIME } from '@openmap/constants';
import type { LifecycleState } from './lifecycle.js';

/** Bumped whenever a framework, control or mapping changes; each stored evaluation records the version it used. */
export const COMPLIANCE_CATALOGUE_VERSION = '2026.11.1';

export const COMPLIANCE_FRAMEWORKS = ['soc2', 'iso27001', 'pci_dss', 'sama_csf', 'nca_ecc'] as const;
export type ComplianceFramework = (typeof COMPLIANCE_FRAMEWORKS)[number];

export const COMPLIANCE_CHECKS = [
  'cve_high_critical',
  'cve_exploited',
  'release_supported',
  'os_patched',
  'hardware_supported',
  'certificate_valid',
  'certificate_strong',
  'tls_modern',
  'storage_encrypted',
  'share_encrypted',
  'bucket_public_blocked',
  'database_backup_recent',
  'platform_backup_recent',
  'firewall_no_permissive',
] as const;
export type ComplianceCheck = (typeof COMPLIANCE_CHECKS)[number];

export const COMPLIANCE_RESULTS = ['pass', 'fail', 'not_applicable'] as const;
export type ComplianceResult = (typeof COMPLIANCE_RESULTS)[number];

/** Why a check decided what it did; each has an i18n sentence (`assets.compliance.reason.<reason>`). */
export const COMPLIANCE_REASONS = [
  'no_high_cve',
  'high_cve',
  'no_exploited_cve',
  'exploited_cve',
  'release_supported',
  'release_ending',
  'release_ended',
  'release_unknown',
  'patched',
  'patch_stale',
  'patch_unknown',
  'hardware_supported',
  'hardware_ended',
  'hardware_undated',
  'certificate_valid',
  'certificate_expired',
  'certificate_strong',
  'certificate_weak',
  'tls_modern',
  'tls_outdated',
  'tls_unknown',
  'encrypted',
  'unencrypted',
  'encryption_unknown',
  'share_encrypted',
  'share_unencrypted',
  'public_blocked',
  'public_open',
  'backup_recent',
  'backup_stale',
  'backup_unreported',
  'platform_backup_recent',
  'platform_backup_stale',
  'platform_backup_missing',
  'platform_backup_unencrypted',
  'firewall_tight',
  'firewall_permissive',
] as const;
export type ComplianceReason = (typeof COMPLIANCE_REASONS)[number];

export type ComplianceFactValue = string | number | boolean | null;

/** One check's decision on one subject (a CI, or the deployment itself when `ciId` is null). */
export interface ComplianceOutcome {
  check: ComplianceCheck;
  ciId: string | null;
  result: ComplianceResult;
  reason: ComplianceReason;
  facts: Record<string, ComplianceFactValue>;
}

export interface ComplianceControl {
  /** The framework's own control identifier. */
  id: string;
  checks: readonly ComplianceCheck[];
}

export interface ComplianceFrameworkDefinition {
  id: ComplianceFramework;
  /** The edition the identifiers refer to. */
  edition: string;
  controls: readonly ComplianceControl[];
}

/** The bundled catalogue. Controls without an automated check from stored facts are left out on purpose (ADR-070). */
export const COMPLIANCE_CATALOGUE: readonly ComplianceFrameworkDefinition[] = [
  {
    id: 'soc2',
    edition: 'AICPA TSC 2017 (rev. 2022)',
    controls: [
      { id: 'CC6.1', checks: ['storage_encrypted', 'bucket_public_blocked'] },
      { id: 'CC6.6', checks: ['firewall_no_permissive', 'bucket_public_blocked'] },
      { id: 'CC6.7', checks: ['tls_modern', 'certificate_valid', 'certificate_strong', 'share_encrypted'] },
      { id: 'CC6.8', checks: ['cve_exploited'] },
      { id: 'CC7.1', checks: ['cve_high_critical', 'release_supported', 'os_patched'] },
      { id: 'A1.2', checks: ['database_backup_recent', 'platform_backup_recent', 'hardware_supported'] },
    ],
  },
  {
    id: 'iso27001',
    edition: 'ISO/IEC 27001:2022 Annex A',
    controls: [
      { id: 'A.7.13', checks: ['hardware_supported'] },
      { id: 'A.8.3', checks: ['bucket_public_blocked'] },
      { id: 'A.8.8', checks: ['cve_high_critical', 'cve_exploited', 'os_patched', 'release_supported'] },
      { id: 'A.8.13', checks: ['database_backup_recent', 'platform_backup_recent'] },
      { id: 'A.8.20', checks: ['firewall_no_permissive'] },
      {
        id: 'A.8.24',
        checks: ['storage_encrypted', 'tls_modern', 'certificate_valid', 'certificate_strong', 'share_encrypted'],
      },
    ],
  },
  {
    id: 'pci_dss',
    edition: 'PCI DSS v4.0.1',
    controls: [
      { id: '1.3', checks: ['firewall_no_permissive', 'bucket_public_blocked'] },
      { id: '3.5', checks: ['storage_encrypted'] },
      { id: '4.2.1', checks: ['tls_modern', 'certificate_valid', 'certificate_strong'] },
      { id: '6.3.3', checks: ['cve_exploited', 'os_patched'] },
      { id: '11.3.1', checks: ['cve_high_critical'] },
      { id: '12.3.4', checks: ['release_supported', 'hardware_supported'] },
    ],
  },
  {
    id: 'sama_csf',
    edition: 'SAMA Cyber Security Framework v1.0',
    controls: [
      { id: '3.3.8', checks: ['firewall_no_permissive', 'release_supported', 'hardware_supported', 'bucket_public_blocked'] },
      {
        id: '3.3.9',
        checks: ['storage_encrypted', 'tls_modern', 'certificate_valid', 'certificate_strong', 'share_encrypted'],
      },
      { id: '3.3.17', checks: ['cve_high_critical', 'cve_exploited', 'os_patched'] },
    ],
  },
  {
    id: 'nca_ecc',
    edition: 'NCA ECC-1:2018',
    controls: [
      { id: '2-3', checks: ['os_patched', 'release_supported', 'hardware_supported'] },
      { id: '2-5', checks: ['firewall_no_permissive'] },
      { id: '2-7', checks: ['bucket_public_blocked', 'storage_encrypted'] },
      {
        id: '2-8',
        checks: ['tls_modern', 'certificate_valid', 'certificate_strong', 'share_encrypted', 'storage_encrypted'],
      },
      { id: '2-9', checks: ['database_backup_recent', 'platform_backup_recent'] },
      { id: '2-10', checks: ['cve_high_critical', 'cve_exploited'] },
    ],
  },
];

export function complianceFramework(id: ComplianceFramework): ComplianceFrameworkDefinition {
  const found = COMPLIANCE_CATALOGUE.find((f) => f.id === id);
  if (found === undefined) throw new Error('unknown compliance framework ' + id);
  return found;
}

/** The checks one framework uses, each once. */
export function frameworkChecks(framework: ComplianceFrameworkDefinition): ComplianceCheck[] {
  return [...new Set(framework.controls.flatMap((c) => c.checks))];
}

function outcome(
  check: ComplianceCheck,
  ciId: string | null,
  result: ComplianceResult,
  reason: ComplianceReason,
  facts: Record<string, ComplianceFactValue>,
): ComplianceOutcome {
  return { check, ciId, result, reason, facts };
}

// ---------------------------------------------------------------------------------------------------------------
// The checks. Each is a pure function of the facts the API gathered for one subject.
// ---------------------------------------------------------------------------------------------------------------

export interface CveFact {
  cveId: string;
  severity: string;
  cvss: number;
  exploited: boolean;
}

/** A CVE is high risk when its severity says so, or, unlabelled, when its CVSS base score is at least the high band. */
export function isHighRiskCve(cve: Pick<CveFact, 'severity' | 'cvss'>): boolean {
  const severity = cve.severity.toLowerCase();
  if ((COMPLIANCE.highRiskSeverities as readonly string[]).includes(severity)) return true;
  return (severity === '' || severity === 'unknown') && cve.cvss >= COMPLIANCE.highRiskCvss;
}

function worst(cves: readonly CveFact[]): CveFact | null {
  return [...cves].sort((a, b) => b.cvss - a.cvss || a.cveId.localeCompare(b.cveId))[0] ?? null;
}

/**
 * The CVE checks of a CI with discovered software: `cve_high_critical` fails on any high or critical CVE affecting
 * the software installed on it, `cve_exploited` on any CVE known to be exploited (or in CISA KEV). A CI without a
 * software inventory has no CVE correlation and is not evaluated (the caller only passes CIs with an inventory).
 */
export function checkCveExposure(ciId: string, installed: number, cves: readonly CveFact[]): ComplianceOutcome[] {
  const high = cves.filter(isHighRiskCve);
  const exploited = cves.filter((c) => c.exploited);
  const worstHigh = worst(high);
  const worstExploited = worst(exploited);
  return [
    high.length > 0
      ? outcome('cve_high_critical', ciId, 'fail', 'high_cve', {
          installed,
          highOrCritical: high.length,
          critical: high.filter((c) => c.severity.toLowerCase() === 'critical').length,
          worstCve: worstHigh?.cveId ?? null,
          worstCvss: worstHigh?.cvss ?? null,
        })
      : outcome('cve_high_critical', ciId, 'pass', 'no_high_cve', { installed, cves: cves.length }),
    exploited.length > 0
      ? outcome('cve_exploited', ciId, 'fail', 'exploited_cve', {
          installed,
          exploited: exploited.length,
          worstCve: worstExploited?.cveId ?? null,
          worstCvss: worstExploited?.cvss ?? null,
        })
      : outcome('cve_exploited', ciId, 'pass', 'no_exploited_cve', { installed, cves: cves.length }),
  ];
}

/** An operating system, hypervisor or network OS release against the lifecycle catalogue. */
export function checkRelease(
  ciId: string,
  release: { state: LifecycleState; label: string; endOfSupport: string | null },
): ComplianceOutcome {
  const facts = { release: release.label, endOfSupport: release.endOfSupport };
  switch (release.state) {
    case 'ended':
      return outcome('release_supported', ciId, 'fail', 'release_ended', facts);
    case 'ending':
      return outcome('release_supported', ciId, 'pass', 'release_ending', facts);
    case 'supported':
      return outcome('release_supported', ciId, 'pass', 'release_supported', facts);
    case 'unknown':
      return outcome('release_supported', ciId, 'not_applicable', 'release_unknown', facts);
  }
}

/** An operating system's last patch date against LIFECYCLE.patchStaleDays (the threshold the Lifecycle screen uses). */
export function checkPatch(ciId: string, lastPatchedAt: string | null, now: Date): ComplianceOutcome {
  const staleDays = LIFECYCLE.patchStaleDays;
  const at = lastPatchedAt === null ? Number.NaN : Date.parse(lastPatchedAt);
  if (Number.isNaN(at)) return outcome('os_patched', ciId, 'not_applicable', 'patch_unknown', { lastPatchedAt: null });
  const ageDays = Math.floor((now.getTime() - at) / TIME.msPerDay);
  const facts = { lastPatchedAt, ageDays, staleDays };
  return ageDays > staleDays
    ? outcome('os_patched', ciId, 'fail', 'patch_stale', facts)
    : outcome('os_patched', ciId, 'pass', 'patched', facts);
}

/** A piece of hardware's end of support from the asset register (the earliest recorded date of the asset). */
export function checkHardware(ciId: string, endOfSupport: string | null, source: string | null, now: Date): ComplianceOutcome {
  if (endOfSupport === null)
    return outcome('hardware_supported', ciId, 'not_applicable', 'hardware_undated', { endOfSupport: null });
  const facts = { endOfSupport, source };
  return Date.parse(endOfSupport) < now.getTime()
    ? outcome('hardware_supported', ciId, 'fail', 'hardware_ended', facts)
    : outcome('hardware_supported', ciId, 'pass', 'hardware_supported', facts);
}

/** A leaf certificate's validity and its key and signature strength (weaknesses under CERTIFICATES' policy). */
export function checkCertificate(
  ciId: string,
  cert: { notAfter: string | null; daysLeft: number | null; expired: boolean; weaknesses: readonly string[]; subject: string },
): ComplianceOutcome[] {
  const validity =
    cert.notAfter === null
      ? null
      : cert.expired
        ? outcome('certificate_valid', ciId, 'fail', 'certificate_expired', { subject: cert.subject, notAfter: cert.notAfter, daysLeft: cert.daysLeft })
        : outcome('certificate_valid', ciId, 'pass', 'certificate_valid', { subject: cert.subject, notAfter: cert.notAfter, daysLeft: cert.daysLeft });
  const strength =
    cert.weaknesses.length > 0
      ? outcome('certificate_strong', ciId, 'fail', 'certificate_weak', { subject: cert.subject, weaknesses: cert.weaknesses.join(', ') })
      : outcome('certificate_strong', ciId, 'pass', 'certificate_strong', { subject: cert.subject });
  return validity === null ? [strength] : [validity, strength];
}

/** The rank of a TLS protocol version in COMPLIANCE.tlsVersions, or -1 when the string names none of them. */
export function tlsRank(version: string | null): number {
  if (version === null) return -1;
  const normal = version.trim().toUpperCase().replace(/^TLSV?/, 'TLS ').replace(/\s+/g, ' ');
  return COMPLIANCE.tlsVersions.findIndex((v) => v.toUpperCase() === normal);
}

/** A TLS listener's negotiated protocol against COMPLIANCE.minTlsVersion. */
export function checkTls(ciId: string, tlsVersion: string | null, endpoint: string | null): ComplianceOutcome {
  const rank = tlsRank(tlsVersion);
  const facts = { tlsVersion, minimum: COMPLIANCE.minTlsVersion, endpoint };
  if (rank < 0) return outcome('tls_modern', ciId, 'not_applicable', 'tls_unknown', facts);
  return rank >= tlsRank(COMPLIANCE.minTlsVersion)
    ? outcome('tls_modern', ciId, 'pass', 'tls_modern', facts)
    : outcome('tls_modern', ciId, 'fail', 'tls_outdated', facts);
}

/**
 * Encryption at rest of a store: a boolean `encryptionAtRest` (database clusters and other stores that report it) or
 * an object store's `encryption` algorithm, where COMPLIANCE.unencryptedValues mean none.
 */
export function checkStorageEncryption(ciId: string, attributes: Readonly<Record<string, unknown>>): ComplianceOutcome {
  const flag = attributes['encryptionAtRest'];
  if (typeof flag === 'boolean')
    return flag
      ? outcome('storage_encrypted', ciId, 'pass', 'encrypted', { encryptionAtRest: true })
      : outcome('storage_encrypted', ciId, 'fail', 'unencrypted', { encryptionAtRest: false });
  const algorithm = attributes['encryption'];
  if (typeof algorithm === 'string') {
    const none = (COMPLIANCE.unencryptedValues as readonly string[]).includes(algorithm.trim().toLowerCase());
    return none
      ? outcome('storage_encrypted', ciId, 'fail', 'unencrypted', { encryption: algorithm })
      : outcome('storage_encrypted', ciId, 'pass', 'encrypted', { encryption: algorithm });
  }
  return outcome('storage_encrypted', ciId, 'not_applicable', 'encryption_unknown', {});
}

/** A file share's protection on the wire: SMB with encryption required, NFS with Kerberos privacy. */
export function checkShareEncryption(ciId: string, protocol: string | null, options: readonly string[]): ComplianceOutcome {
  const lower = options.map((o) => o.trim().toLowerCase());
  const facts = { protocol, options: lower.join(', ') };
  const p = (protocol ?? '').toLowerCase();
  const encrypted =
    p === 'smb'
      ? lower.includes(COMPLIANCE.smbEncryptOption)
      : p === 'nfs'
        ? lower.some((o) => (COMPLIANCE.nfsPrivacyOptions as readonly string[]).includes(o))
        : null;
  if (encrypted === null) return outcome('share_encrypted', ciId, 'not_applicable', 'encryption_unknown', facts);
  return encrypted
    ? outcome('share_encrypted', ciId, 'pass', 'share_encrypted', facts)
    : outcome('share_encrypted', ciId, 'fail', 'share_unencrypted', facts);
}

/** An object bucket's public access block, as the object store collector reports it. */
export function checkBucketPublic(ciId: string, publicAccessBlocked: boolean | null): ComplianceOutcome | null {
  if (publicAccessBlocked === null) return null;
  return publicAccessBlocked
    ? outcome('bucket_public_blocked', ciId, 'pass', 'public_blocked', { publicAccessBlocked: true })
    : outcome('bucket_public_blocked', ciId, 'fail', 'public_open', { publicAccessBlocked: false });
}

/** A database's last backup against COMPLIANCE.databaseBackupMaxAgeHours; a database that reports none is not evaluated. */
export function checkDatabaseBackup(ciId: string, lastBackupAt: string | null, now: Date): ComplianceOutcome {
  const at = lastBackupAt === null ? Number.NaN : Date.parse(lastBackupAt);
  if (Number.isNaN(at)) return outcome('database_backup_recent', ciId, 'not_applicable', 'backup_unreported', { lastBackupAt: null });
  const ageHours = Math.floor((now.getTime() - at) / TIME.msPerHour);
  const facts = { lastBackupAt, ageHours, maxAgeHours: COMPLIANCE.databaseBackupMaxAgeHours };
  return ageHours > COMPLIANCE.databaseBackupMaxAgeHours
    ? outcome('database_backup_recent', ciId, 'fail', 'backup_stale', facts)
    : outcome('database_backup_recent', ciId, 'pass', 'backup_recent', facts);
}

/**
 * The deployment's own stores of record (REQ-INT-019 backup manifests): a recent, complete and encrypted backup set.
 * No backup directory, or no complete set, fails: the CMDB itself is evidence an auditor asks for.
 */
export function checkPlatformBackup(backups: {
  configured: boolean;
  stale: boolean;
  lastCompleteAt: string | null;
  newestEncrypted: boolean | null;
  staleAfterHours: number;
}): ComplianceOutcome {
  const facts = { configured: backups.configured, lastCompleteAt: backups.lastCompleteAt, staleAfterHours: backups.staleAfterHours };
  if (!backups.configured || backups.lastCompleteAt === null)
    return outcome('platform_backup_recent', null, 'fail', 'platform_backup_missing', facts);
  if (backups.stale) return outcome('platform_backup_recent', null, 'fail', 'platform_backup_stale', facts);
  if (backups.newestEncrypted === false)
    return outcome('platform_backup_recent', null, 'fail', 'platform_backup_unencrypted', { ...facts, encrypted: false });
  return outcome('platform_backup_recent', null, 'pass', 'platform_backup_recent', { ...facts, encrypted: backups.newestEncrypted });
}

/** A firewall's rule base fails on a permissive rule: one that allows every service between unrestricted addresses. */
export function checkFirewall(ciId: string, rules: number, permissive: number, truncated: boolean): ComplianceOutcome {
  const facts = { rules, permissive, truncated };
  return permissive > 0
    ? outcome('firewall_no_permissive', ciId, 'fail', 'firewall_permissive', facts)
    : outcome('firewall_no_permissive', ciId, 'pass', 'firewall_tight', facts);
}

// ---------------------------------------------------------------------------------------------------------------
// Posture: what the outcomes mean for each framework.
// ---------------------------------------------------------------------------------------------------------------

export interface ComplianceTally {
  passed: number;
  failed: number;
  notApplicable: number;
}

export interface ControlPosture {
  controlId: string;
  checks: ComplianceCheck[];
  /** fail when any evaluation fails, pass when at least one passes and none fails, otherwise not_applicable. */
  result: ComplianceResult;
  tally: ComplianceTally;
}

export interface FrameworkPosture {
  framework: ComplianceFramework;
  edition: string;
  /** passed / (passed + failed) over the framework's evaluations; null when nothing could be evaluated. */
  passRate: number | null;
  evaluations: ComplianceTally;
  controlsPassed: number;
  controlsFailed: number;
  controlsNotApplicable: number;
  controls: ControlPosture[];
  /** CIs failing any of the framework's controls that carry a high or critical CVE. */
  highRiskCis: number;
}

export interface CveRisk {
  critical: number;
  high: number;
  exploited: number;
  /** CIs with at least one high or critical CVE. */
  exposedCis: number;
}

export function emptyTally(): ComplianceTally {
  return { passed: 0, failed: 0, notApplicable: 0 };
}

export function addToTally(tally: ComplianceTally, result: ComplianceResult, n = 1): void {
  if (result === 'pass') tally.passed += n;
  else if (result === 'fail') tally.failed += n;
  else tally.notApplicable += n;
}

export function passRate(tally: ComplianceTally): number | null {
  const decided = tally.passed + tally.failed;
  return decided === 0 ? null : tally.passed / decided;
}

export function controlResult(tally: ComplianceTally): ComplianceResult {
  if (tally.failed > 0) return 'fail';
  if (tally.passed > 0) return 'pass';
  return 'not_applicable';
}

/**
 * Per-framework posture from the outcomes of one evaluation. `anchorOf` maps a subject to the CI its risk belongs to
 * (an operating system to the host it is installed on), so a host whose OS is unsupported and which carries a
 * critical CVE counts once as a high-risk CI; `exposed` is the set of CIs with a high or critical CVE.
 */
export function compliancePosture(
  outcomes: readonly ComplianceOutcome[],
  exposed: ReadonlySet<string>,
  anchorOf: ReadonlyMap<string, string>,
  catalogue: readonly ComplianceFrameworkDefinition[] = COMPLIANCE_CATALOGUE,
): FrameworkPosture[] {
  const byCheck = new Map<ComplianceCheck, ComplianceTally>();
  const failingByCheck = new Map<ComplianceCheck, Set<string>>();
  for (const o of outcomes) {
    const tally = byCheck.get(o.check) ?? emptyTally();
    addToTally(tally, o.result);
    byCheck.set(o.check, tally);
    if (o.result === 'fail' && o.ciId !== null) {
      const set = failingByCheck.get(o.check) ?? new Set<string>();
      set.add(anchorOf.get(o.ciId) ?? o.ciId);
      failingByCheck.set(o.check, set);
    }
  }
  return catalogue.map((framework) => {
    const controls = framework.controls.map((control): ControlPosture => {
      const tally = emptyTally();
      for (const check of control.checks) {
        const t = byCheck.get(check);
        if (t === undefined) continue;
        tally.passed += t.passed;
        tally.failed += t.failed;
        tally.notApplicable += t.notApplicable;
      }
      return { controlId: control.id, checks: [...control.checks], result: controlResult(tally), tally };
    });
    // Evaluations are counted once per check even when two controls of the framework share it.
    const evaluations = emptyTally();
    const failing = new Set<string>();
    for (const check of frameworkChecks(framework)) {
      const t = byCheck.get(check);
      if (t !== undefined) {
        evaluations.passed += t.passed;
        evaluations.failed += t.failed;
        evaluations.notApplicable += t.notApplicable;
      }
      for (const ci of failingByCheck.get(check) ?? []) failing.add(ci);
    }
    let highRiskCis = 0;
    for (const ci of failing) if (exposed.has(ci)) highRiskCis += 1;
    return {
      framework: framework.id,
      edition: framework.edition,
      passRate: passRate(evaluations),
      evaluations,
      controlsPassed: controls.filter((c) => c.result === 'pass').length,
      controlsFailed: controls.filter((c) => c.result === 'fail').length,
      controlsNotApplicable: controls.filter((c) => c.result === 'not_applicable').length,
      controls,
      highRiskCis,
    };
  });
}

/** Distinct high, critical and exploited CVEs over the CIs' exposure, and how many CIs carry a high or critical one. */
export function cveRisk(exposure: ReadonlyMap<string, readonly CveFact[]>): CveRisk {
  const critical = new Set<string>();
  const high = new Set<string>();
  const exploited = new Set<string>();
  let exposedCis = 0;
  for (const cves of exposure.values()) {
    let any = false;
    for (const c of cves) {
      if (isHighRiskCve(c)) {
        any = true;
        if (c.severity.toLowerCase() === 'critical') critical.add(c.cveId);
        else high.add(c.cveId);
      }
      if (c.exploited) exploited.add(c.cveId);
    }
    if (any) exposedCis += 1;
  }
  return { critical: critical.size, high: high.size, exploited: exploited.size, exposedCis };
}
