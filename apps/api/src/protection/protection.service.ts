// REQ-INT-017 (ADR-075) — backup and DR awareness over the backup collector's CIs. A CI is covered by every backup
// policy (backup_policy CI) it has a current backed_by edge to; a database or database cluster without a cover of its
// own inherits the covers of the compute it is hosted on whose agents are application-aware for databases. Whether the
// covers meet the CI's recovery point objective is judged by the contract (judgeProtection) against the strictest of
// the policies' RPOs and those of the business services the CI supports, found by the impact walk. The gaps list walks
// down from the members of every critical service (tier BACKUP_AWARENESS.criticalMaxTier or more critical) to the
// protectable CIs that support them and returns those unprotected or past their RPO.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { BACKUP_AWARENESS, GRAPH } from '@openmap/constants';
import {
  BACKUP_COVER_ATTRIBUTES,
  BACKUP_POLICY_ATTRIBUTES,
  coversDatabases,
  judgeProtection,
  PROTECTABLE_CI_TYPES,
  type CiType,
  type ProtectionState,
  type RelationshipType,
} from '@openmap/contracts';
import { relLabel } from '@openmap/graph';
import { withSpan } from '@openmap/telemetry';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord, RelationshipRecord } from '../ci/ci.types.js';
import { numberAttribute, stringArrayAttribute, stringAttribute } from '../common/validation.js';
import { GraphService } from '../db/graph.service.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { DEFAULT_TIER, PART_OF_SERVICE, SERVICE_ATTRIBUTES } from '../services/bsm-facts.service.js';

const BACKED_BY: RelationshipType = 'backed_by';
const HOSTED_ON: RelationshipType = 'hosted_on';
const POLICY_TYPE: CiType = 'backup_policy';
const SERVICE_TYPE: CiType = 'business_service';
const DATABASE_TYPES: ReadonlySet<CiType> = new Set<CiType>(['database', 'database_cluster']);
const PROTECTABLE: ReadonlySet<string> = new Set<string>(PROTECTABLE_CI_TYPES);
/** Business-service attribute holding the recovery point objective the service requires, in minutes. */
export const SERVICE_RPO_ATTRIBUTE = 'rpoMinutes';
/** Gap order: the worst state first. */
const STATE_ORDER: readonly ProtectionState[] = ['unprotected', 'rpo_breached', 'protected'];

export interface BackupCoverView {
  policy: CiRecord;
  vendor: string;
  policyKind: string;
  server: string | null;
  lastGoodBackupAt: string | null;
  lastResult: string | null;
  restorePoints: number | null;
  rpoMinutes: number | null;
  retentionDays: number | null;
  agents: string[];
  via: CiRecord | null;
}

export interface ProtectionServiceView {
  service: CiRecord;
  tier: number;
  rpoMinutes: number | null;
}

export interface CiProtectionView {
  ci: CiRecord;
  state: ProtectionState;
  lastGoodBackupAt: string | null;
  policyRpoMinutes: number | null;
  targetRpoMinutes: number;
  ageMinutes: number | null;
  covers: BackupCoverView[];
  services: ProtectionServiceView[];
}

export interface ProtectionGapsView {
  maxTier: number;
  criticalServices: number;
  criticalCis: number;
  protected: number;
  rpoBreached: number;
  unprotected: number;
  truncated: boolean;
  items: CiProtectionView[];
}

/** The tier a business service declares, the default (standard) tier when it declares none. */
export function serviceTier(service: CiRecord): number {
  return numberAttribute(service.attributes, SERVICE_ATTRIBUTES.tier) ?? DEFAULT_TIER;
}

/** A cover as read from a backed_by edge and its policy: the edge's figures first, the policy's where the edge has none. */
export function coverOf(edge: RelationshipRecord, policy: CiRecord, via: CiRecord | null): BackupCoverView {
  const e = edge.attributes;
  const p = policy.attributes;
  return {
    policy,
    vendor: stringAttribute(e, BACKUP_COVER_ATTRIBUTES.vendor) ?? stringAttribute(p, BACKUP_POLICY_ATTRIBUTES.vendor) ?? '',
    policyKind: stringAttribute(p, BACKUP_POLICY_ATTRIBUTES.policyKind) ?? '',
    server: stringAttribute(p, BACKUP_POLICY_ATTRIBUTES.server),
    lastGoodBackupAt: stringAttribute(e, BACKUP_COVER_ATTRIBUTES.lastGoodBackupAt),
    lastResult: stringAttribute(e, BACKUP_COVER_ATTRIBUTES.lastResult) ?? stringAttribute(p, BACKUP_POLICY_ATTRIBUTES.lastResult),
    restorePoints: numberAttribute(e, BACKUP_COVER_ATTRIBUTES.restorePoints),
    rpoMinutes: numberAttribute(e, BACKUP_COVER_ATTRIBUTES.rpoMinutes) ?? numberAttribute(p, BACKUP_POLICY_ATTRIBUTES.rpoMinutes),
    retentionDays:
      numberAttribute(e, BACKUP_COVER_ATTRIBUTES.retentionDays) ?? numberAttribute(p, BACKUP_POLICY_ATTRIBUTES.retentionDays),
    agents: stringArrayAttribute(e, BACKUP_COVER_ATTRIBUTES.agents),
    via,
  };
}

/** The protection of a CI from its covers and the services it supports. */
export function protectionOf(
  ci: CiRecord,
  covers: readonly BackupCoverView[],
  services: readonly ProtectionServiceView[],
  now: Date,
): CiProtectionView {
  const judged = judgeProtection(
    covers.map((c) => ({ lastGoodBackupAt: c.lastGoodBackupAt, rpoMinutes: c.rpoMinutes })),
    services.map((s) => s.rpoMinutes),
    now,
  );
  return { ci, ...judged, covers: [...covers], services: [...services] };
}

/** Gaps first (unprotected, then past RPO), each by the most critical service it supports, then by name. */
export function compareGaps(a: CiProtectionView, b: CiProtectionView): number {
  const tier = (v: CiProtectionView): number => Math.min(...v.services.map((s) => s.tier), Number.MAX_SAFE_INTEGER);
  return STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || tier(a) - tier(b) || a.ci.name.localeCompare(b.ci.name);
}

// The support walk, breadth first from each member of the critical services (as the impact walk, ADR-019: `contains`
// only from logical containers). Retired CIs and edges are not in the graph.
const SUPPORT_EDGES = BACKUP_AWARENESS.supportEdgeTypes.map((t) => relLabel(t)).join('|');
const CONTAINS_LABEL = relLabel('contains');
const SUPPORT_QUERY =
  'UNWIND $serviceIds AS sid\n' +
  'MATCH (s:Ci {id: sid, tenantId: $tenantId})<-[:' + relLabel(PART_OF_SERVICE) + ']-(m:Ci)\n' +
  'WHERE m.tenantId = $tenantId\n' +
  'MATCH p = (m)-[:' + SUPPORT_EDGES + ' *BFS ..' + String(BACKUP_AWARENESS.supportWalkDepth) +
  " (r, n | type(r) <> '" + CONTAINS_LABEL + "' OR startNode(r).type IN $containerTypes)]->(x)\n" +
  'WHERE x.tenantId = $tenantId AND x.type IN $types\n' +
  'RETURN DISTINCT x.id AS id, s.id AS serviceId';
const MEMBER_QUERY =
  'UNWIND $serviceIds AS sid\n' +
  'MATCH (s:Ci {id: sid, tenantId: $tenantId})<-[:' + relLabel(PART_OF_SERVICE) + ']-(m:Ci)\n' +
  'WHERE m.tenantId = $tenantId AND m.type IN $types\n' +
  'RETURN DISTINCT m.id AS id, s.id AS serviceId';

@Injectable()
export class ProtectionService {
  constructor(
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly graph: GraphService,
    private readonly metrics: MetricsService,
  ) {}

  /** Covers of each CI: its own backed_by edges to policies, else (databases) its hosts' database-aware covers. */
  async coversOf(tenantId: string, targets: readonly CiRecord[]): Promise<Map<string, BackupCoverView[]>> {
    const out = new Map<string, BackupCoverView[]>(targets.map((c) => [c.id, []]));
    if (targets.length === 0) return out;
    const direct = await this.policyEdges(
      tenantId,
      targets.map((c) => c.id),
    );
    for (const { edge, policy } of direct) out.get(edge.fromCiId)?.push(coverOf(edge, policy, null));
    const bare = targets.filter((c) => DATABASE_TYPES.has(c.type) && (out.get(c.id)?.length ?? 0) === 0);
    if (bare.length === 0) return out;
    const hosting = await this.cis.relationshipsOfMany(
      tenantId,
      bare.map((c) => c.id),
      [HOSTED_ON],
      'downstream',
    );
    const hostIds = [...new Set(hosting.map((r) => r.toCiId))];
    const [hosts, hostEdges] = await Promise.all([this.cis.findByIds(tenantId, hostIds), this.policyEdges(tenantId, hostIds)]);
    const hostById = new Map(hosts.map((h) => [h.id, h]));
    for (const h of hosting) {
      const host = hostById.get(h.toCiId);
      if (host === undefined) continue;
      for (const { edge, policy } of hostEdges) {
        if (edge.fromCiId !== host.id) continue;
        if (!coversDatabases(stringArrayAttribute(edge.attributes, BACKUP_COVER_ATTRIBUTES.agents))) continue;
        out.get(h.fromCiId)?.push(coverOf(edge, policy, host));
      }
    }
    return out;
  }

  private async policyEdges(
    tenantId: string,
    ciIds: readonly string[],
  ): Promise<Array<{ edge: RelationshipRecord; policy: CiRecord }>> {
    const edges = await this.cis.relationshipsOfMany(tenantId, ciIds, [BACKED_BY], 'downstream');
    if (edges.length === 0) return [];
    const policies = new Map(
      (
        await this.cis.findByIds(
          tenantId,
          [...new Set(edges.map((e) => e.toCiId))],
        )
      )
        .filter((p) => p.type === POLICY_TYPE)
        .map((p) => [p.id, p]),
    );
    const out: Array<{ edge: RelationshipRecord; policy: CiRecord }> = [];
    for (const edge of edges) {
      const policy = policies.get(edge.toCiId);
      if (policy !== undefined) out.push({ edge, policy });
    }
    return out;
  }

  private servicesOf(service: CiRecord): ProtectionServiceView {
    return { service, tier: serviceTier(service), rpoMinutes: numberAttribute(service.attributes, SERVICE_RPO_ATTRIBUTE) };
  }

  /** One CI's protection; null for a type no backup protects. */
  async ci(tenantId: string, ciId: string, now: Date = new Date()): Promise<CiProtectionView | null> {
    return withSpan(TRACER_NAME, 'bsm.protection.ci', { 'openmap.tenant': tenantId, 'openmap.ci': ciId }, async () => {
      const ci = await this.cis.findById(tenantId, ciId, null);
      if (ci === null) throw new NotFoundException('CI ' + ciId + ' not found');
      this.metrics.protectionReads.inc({ query: 'ci' });
      if (!PROTECTABLE.has(ci.type)) return null;
      const [covers, impact] = await Promise.all([
        this.coversOf(tenantId, [ci]),
        this.graph.repo.impact(tenantId, ci.id, { direction: 'upstream', maxDepth: GRAPH.defaultImpactDepth, asOf: null, edgeTypes: [] }),
      ]);
      const services = (
        await this.cis.findByIds(
          tenantId,
          impact.services.map((s) => s.ci.id),
        )
      )
        .filter((s) => s.type === SERVICE_TYPE)
        .map((s) => this.servicesOf(s))
        .sort((a, b) => a.tier - b.tier || a.service.name.localeCompare(b.service.name));
      return protectionOf(ci, covers.get(ci.id) ?? [], services, now);
    });
  }

  /** Protectable CIs supporting business services of `maxTier` or more critical, and those not protected within RPO. */
  async gaps(tenantId: string, maxTier: number, first: number, now: Date = new Date()): Promise<ProtectionGapsView> {
    return withSpan(TRACER_NAME, 'bsm.protection.gaps', { 'openmap.tenant': tenantId, 'openmap.max_tier': maxTier }, async () => {
      this.metrics.protectionReads.inc({ query: 'gaps' });
      const critical = (await this.cis.byType(tenantId, SERVICE_TYPE)).filter((s) => serviceTier(s) <= maxTier);
      const serviceById = new Map(critical.map((s) => [s.id, this.servicesOf(s)]));
      const supported = new Map<string, Set<string>>();
      if (critical.length > 0) {
        const params = {
          tenantId,
          serviceIds: critical.map((s) => s.id),
          types: [...PROTECTABLE_CI_TYPES],
          containerTypes: [...GRAPH.impactContainerTypes],
        };
        const rows = (
          await Promise.all([
            this.graph.repo.readOnly<{ id: string; serviceId: string }>(SUPPORT_QUERY, params),
            this.graph.repo.readOnly<{ id: string; serviceId: string }>(MEMBER_QUERY, params),
          ])
        ).flat();
        for (const r of rows) supported.set(r.id, (supported.get(r.id) ?? new Set()).add(r.serviceId));
      }
      const targets = (await this.cis.findByIds(tenantId, [...supported.keys()])).filter((c) => PROTECTABLE.has(c.type));
      const covers = await this.coversOf(tenantId, targets);
      const judged = targets.map((ci) =>
        protectionOf(
          ci,
          covers.get(ci.id) ?? [],
          [...(supported.get(ci.id) ?? [])]
            .map((id) => serviceById.get(id))
            .filter((s): s is ProtectionServiceView => s !== undefined)
            .sort((a, b) => a.tier - b.tier || a.service.name.localeCompare(b.service.name)),
          now,
        ),
      );
      const count = (state: ProtectionState): number => judged.filter((j) => j.state === state).length;
      const gaps = judged.filter((j) => j.state !== 'protected').sort(compareGaps);
      return {
        maxTier,
        criticalServices: critical.length,
        criticalCis: judged.length,
        protected: count('protected'),
        rpoBreached: count('rpo_breached'),
        unprotected: count('unprotected'),
        truncated: gaps.length > first,
        items: gaps.slice(0, first),
      };
    });
  }
}
