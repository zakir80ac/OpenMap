// REQ-UI-015 REQ-UI-016 REQ-CMDB-030 REQ-CMDB-031 REQ-CMDB-035 REQ-SEC-008 — software inventory, licence compliance
// and vulnerabilities over the CIs the collectors discovered: software ← member_of ← software_instance → installed_on →
// host/vm, software → licensed_by → licence → covered_by → contract, software → affected_by → vulnerability. A CVE's
// blast radius walks the dependency graph upstream from the hosts running the affected software to the business
// services (bounded by VULNERABILITY.maxBlastRadiusHosts so a widespread CVE stays within the impact budget).
import { Inject, Injectable } from '@nestjs/common';
import { VULNERABILITY } from '@openmap/constants';
import type { RelationshipType } from '@openmap/contracts';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord } from '../ci/ci.types.js';
import { toMoney } from '../common/money.js';
import { booleanAttribute, isoAttribute, numberAttribute, stringAttribute } from '../common/validation.js';
import { GraphQueryService } from '../graph/graph.service.js';
import type { AffectedServiceView } from '../graph/graph.types.js';
import type {
  LicenceSummaryView,
  SoftwareProductView,
  VulnerabilityDetailView,
  VulnerabilitySummaryView,
} from './software.types.js';

export const MEMBER_OF: RelationshipType = 'member_of';
export const INSTALLED_ON: RelationshipType = 'installed_on';
export const LICENSED_BY: RelationshipType = 'licensed_by';
export const COVERED_BY: RelationshipType = 'covered_by';
export const AFFECTED_BY: RelationshipType = 'affected_by';

/** Severity rank for sorting, worst first. */
const SEVERITY_ORDER: readonly string[] = ['critical', 'high', 'medium', 'low', 'unknown'];

function first<T>(
  attributes: Record<string, unknown>,
  names: readonly string[],
  read: (a: Record<string, unknown>, k: string) => T | null,
): T | null {
  for (const name of names) {
    const value = read(attributes, name);
    if (value !== null) return value;
  }
  return null;
}

/** Attribute names the vulnerability feeds and the synthetic estate use, collectors' first. */
export function toVulnerabilitySummary(
  vuln: CiRecord,
  affectedSoftware: number,
  affectedHosts: number,
  internetFacing: boolean,
): VulnerabilitySummaryView {
  const a = vuln.attributes;
  return {
    ci: vuln,
    cveId: stringAttribute(vuln.identity, 'cveId') ?? stringAttribute(a, 'cveId') ?? vuln.name,
    title: stringAttribute(a, 'title') ?? vuln.displayName,
    severity: (stringAttribute(a, 'severity') ?? 'unknown').toLowerCase(),
    cvss: first(a, ['cvssScore', 'cvss'], numberAttribute) ?? 0,
    exploited: first(a, ['exploitedInWild', 'exploited'], booleanAttribute) ?? false,
    cisaKev: booleanAttribute(a, 'cisaKev') ?? false,
    patchAvailable: booleanAttribute(a, 'patchAvailable') ?? false,
    publishedAt: isoAttribute(a, 'publishedAt'),
    internetFacing,
    affectedSoftware,
    affectedHosts,
    fixedIn: stringAttribute(a, 'fixedIn'),
  };
}

export function toLicence(licence: CiRecord, contract: CiRecord | null): LicenceSummaryView {
  const a = licence.attributes;
  const entitlement = numberAttribute(a, 'entitlement') ?? 0;
  const consumed = numberAttribute(a, 'consumed') ?? 0;
  // Licence feeds carry calendar dates as often as instants; the contract's DateTime wants an ISO instant.
  const expiresAt = isoAttribute(a, 'expiresAt');
  return {
    ci: licence,
    metric: stringAttribute(a, 'metric') ?? 'unknown',
    licenceType: stringAttribute(a, 'licenceType') ?? 'unknown',
    entitlement,
    consumed,
    overDeployed: booleanAttribute(a, 'overDeployed') ?? consumed > entitlement,
    expiresAt,
    expired:
      booleanAttribute(a, 'expired') ?? (expiresAt !== null && new Date(expiresAt).getTime() < Date.now()),
    annualCost: toMoney(numberAttribute(a, 'annualCost'), stringAttribute(a, 'currency')),
    contract,
  };
}

interface Index {
  instancesBySoftware: Map<string, CiRecord[]>;
  hostsBySoftware: Map<string, Set<string>>;
  hostIds: Set<string>;
}

@Injectable()
export class SoftwareService {
  constructor(
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly graph: GraphQueryService,
  ) {}

  /** Instances and hosts per software product, from member_of and installed_on. */
  private async index(tenantId: string, softwareIds: readonly string[]): Promise<Index> {
    const memberOf = (await this.cis.relationshipsByType(tenantId, MEMBER_OF)).filter((r) =>
      softwareIds.includes(r.toCiId),
    );
    const instanceIds = [...new Set(memberOf.map((r) => r.fromCiId))];
    const instances = new Map((await this.cis.findByIds(tenantId, instanceIds)).map((c) => [c.id, c]));
    const installedOn = instanceIds.length
      ? await this.cis.relationshipsOfMany(tenantId, instanceIds, [INSTALLED_ON], 'downstream')
      : [];
    const hostOfInstance = new Map<string, string>();
    for (const r of installedOn) hostOfInstance.set(r.fromCiId, r.toCiId);
    const instancesBySoftware = new Map<string, CiRecord[]>();
    const hostsBySoftware = new Map<string, Set<string>>();
    const hostIds = new Set<string>();
    for (const r of memberOf) {
      const instance = instances.get(r.fromCiId);
      if (!instance) continue;
      instancesBySoftware.set(r.toCiId, [...(instancesBySoftware.get(r.toCiId) ?? []), instance]);
      const host = hostOfInstance.get(instance.id);
      if (host !== undefined) {
        const set = hostsBySoftware.get(r.toCiId) ?? new Set<string>();
        set.add(host);
        hostsBySoftware.set(r.toCiId, set);
        hostIds.add(host);
      }
    }
    return { instancesBySoftware, hostsBySoftware, hostIds };
  }

  async software(
    tenantId: string,
    text: string | null,
    licensedOnly: boolean,
    first: number,
  ): Promise<SoftwareProductView[]> {
    let products = await this.cis.byType(tenantId, 'software');
    if (text !== null && text.trim() !== '') {
      const needle = text.trim().toLowerCase();
      products = products.filter((p) =>
        (
          p.displayName +
          ' ' +
          (stringAttribute(p.identity, 'vendor') ?? '') +
          ' ' +
          (stringAttribute(p.identity, 'name') ?? '')
        )
          .toLowerCase()
          .includes(needle),
      );
    }
    const ids = products.map((p) => p.id);
    const [index, licensedBy, affectedBy] = await Promise.all([
      this.index(tenantId, ids),
      this.cis.relationshipsByType(tenantId, LICENSED_BY),
      this.cis.relationshipsByType(tenantId, AFFECTED_BY),
    ]);
    const licenceIds = [...new Set(licensedBy.filter((r) => ids.includes(r.fromCiId)).map((r) => r.toCiId))];
    const licences = new Map((await this.cis.findByIds(tenantId, licenceIds)).map((c) => [c.id, c]));
    const coveredBy = licenceIds.length
      ? await this.cis.relationshipsOfMany(tenantId, licenceIds, [COVERED_BY], 'downstream')
      : [];
    const contracts = new Map(
      (await this.cis.findByIds(tenantId, [...new Set(coveredBy.map((r) => r.toCiId))])).map((c) => [
        c.id,
        c,
      ]),
    );
    const licenceOf = new Map<string, LicenceSummaryView>();
    for (const r of licensedBy) {
      const licence = licences.get(r.toCiId);
      if (!licence || licenceOf.has(r.fromCiId)) continue;
      const contractRel = coveredBy.find((c) => c.fromCiId === licence.id);
      licenceOf.set(
        r.fromCiId,
        toLicence(licence, contractRel ? (contracts.get(contractRel.toCiId) ?? null) : null),
      );
    }
    const vulnCount = new Map<string, number>();
    for (const r of affectedBy) vulnCount.set(r.fromCiId, (vulnCount.get(r.fromCiId) ?? 0) + 1);
    const views = products.map((p): SoftwareProductView => {
      const instances = index.instancesBySoftware.get(p.id) ?? [];
      return {
        ci: p,
        vendor: stringAttribute(p.identity, 'vendor') ?? stringAttribute(p.attributes, 'vendor') ?? '',
        name: stringAttribute(p.identity, 'name') ?? p.name,
        version: stringAttribute(p.identity, 'version') ?? stringAttribute(p.attributes, 'version') ?? '',
        category: stringAttribute(p.attributes, 'category'),
        endOfSupport: isoAttribute(p.attributes, 'endOfSupport'),
        instances: instances.length,
        hosts: index.hostsBySoftware.get(p.id)?.size ?? 0,
        running: instances.filter((i) => booleanAttribute(i.attributes, 'running') === true).length,
        licence: licenceOf.get(p.id) ?? null,
        vulnerabilities: vulnCount.get(p.id) ?? 0,
      };
    });
    return views
      .filter((v) => !licensedOnly || v.licence !== null)
      .sort(
        (a, b) =>
          b.instances - a.instances || a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name),
      )
      .slice(0, first);
  }

  private async summaries(
    tenantId: string,
  ): Promise<{
    summaries: VulnerabilitySummaryView[];
    softwareOf: Map<string, CiRecord[]>;
    hostsOf: Map<string, Set<string>>;
  }> {
    const [vulns, affectedBy] = await Promise.all([
      this.cis.byType(tenantId, 'vulnerability'),
      this.cis.relationshipsByType(tenantId, AFFECTED_BY),
    ]);
    const softwareIds = [...new Set(affectedBy.map((r) => r.fromCiId))];
    const software = new Map((await this.cis.findByIds(tenantId, softwareIds)).map((c) => [c.id, c]));
    const index = await this.index(tenantId, softwareIds);
    const hosts = new Map((await this.cis.findByIds(tenantId, [...index.hostIds])).map((c) => [c.id, c]));
    const softwareOf = new Map<string, CiRecord[]>();
    const hostsOf = new Map<string, Set<string>>();
    for (const r of affectedBy) {
      const s = software.get(r.fromCiId);
      if (!s) continue;
      softwareOf.set(r.toCiId, [...(softwareOf.get(r.toCiId) ?? []), s]);
      const set = hostsOf.get(r.toCiId) ?? new Set<string>();
      for (const h of index.hostsBySoftware.get(s.id) ?? []) set.add(h);
      hostsOf.set(r.toCiId, set);
    }
    const summaries = vulns.map((v) => {
      const hostIds = [...(hostsOf.get(v.id) ?? [])];
      const internetFacing = hostIds.some(
        (id) =>
          booleanAttribute(hosts.get(id)?.attributes ?? {}, 'internetFacing') === true ||
          (hosts.get(id)?.tags ?? []).includes('internet-facing'),
      );
      return toVulnerabilitySummary(v, softwareOf.get(v.id)?.length ?? 0, hostIds.length, internetFacing);
    });
    return { summaries, softwareOf, hostsOf };
  }

  async vulnerabilitySummaries(
    tenantId: string,
    minCvss: number | null,
    exploitedOnly: boolean,
    internetFacing: boolean | null,
  ): Promise<VulnerabilitySummaryView[]> {
    const { summaries } = await this.summaries(tenantId);
    return summaries
      .filter(
        (v) =>
          (minCvss === null || v.cvss >= minCvss) &&
          (!exploitedOnly || v.exploited || v.cisaKev) &&
          (internetFacing === null || v.internetFacing === internetFacing),
      )
      .sort(
        (a, b) =>
          b.cvss - a.cvss ||
          SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
          b.affectedHosts - a.affectedHosts,
      );
  }

  async vulnerability(tenantId: string, cveId: string): Promise<VulnerabilityDetailView | null> {
    const { summaries, softwareOf, hostsOf } = await this.summaries(tenantId);
    const summary = summaries.find((v) => v.cveId === cveId);
    if (!summary) return null;
    const hostIds = [...(hostsOf.get(summary.ci.id) ?? [])];
    const hosts = await this.cis.findByIds(tenantId, hostIds);
    const walk = hostIds.slice(0, VULNERABILITY.maxBlastRadiusHosts);
    const services = new Map<string, AffectedServiceView>();
    for (const hostId of walk) {
      const impact = await this.graph.impact(
        tenantId,
        hostId,
        'upstream',
        VULNERABILITY.blastRadiusDepth,
        null,
      );
      for (const s of impact.services) {
        const existing = services.get(s.service.id);
        if (!existing || SEVERITY_ORDER.indexOf(s.predicted) < SEVERITY_ORDER.indexOf(existing.predicted))
          services.set(s.service.id, s);
      }
    }
    return {
      summary,
      software: softwareOf.get(summary.ci.id) ?? [],
      hosts: hosts.sort((a, b) => a.displayName.localeCompare(b.displayName)),
      services: [...services.values()].sort(
        (a, b) => a.tier - b.tier || a.service.displayName.localeCompare(b.service.displayName),
      ),
      blastRadiusTruncated: hostIds.length > walk.length,
    };
  }
}
