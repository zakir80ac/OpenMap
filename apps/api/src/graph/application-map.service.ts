// REQ-DEP-004 (ADR-031) — Query.applicationMap: reads one application's components (`contains`), where each runs
// (`runs_on` / `hosted_on`, walked up to APPLICATION_MAP.placementHops), the dependency edges touching its components
// (`depends_on`, `backed_by`; derived from flows or asserted) and the business services it is part of, from Postgres,
// and resolves every CI. One span and one histogram observation per map.
import { Inject, Injectable } from '@nestjs/common';
import { APPLICATION_MAP, TIME } from '@openmap/constants';
import { Prisma } from '@openmap/db';
import { withSpan } from '@openmap/telemetry';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord } from '../ci/ci.types.js';
import { PrismaService } from '../db/prisma.service.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { classifyDependencies, groupTiers, type DependencyDirection, type EdgeRow } from './application-map.js';

export interface ApplicationComponentView {
  ci: CiRecord;
  tier: string;
  technology: string | null;
  protocol: string | null;
  port: number | null;
  deployment: string | null;
  instances: number | null;
}

export interface PlacementView {
  ci: CiRecord;
  parentId: string;
  relationship: string;
  hop: number;
}

export interface ApplicationDependencyView {
  id: string;
  from: CiRecord;
  to: CiRecord;
  type: string;
  direction: DependencyDirection;
  otherApplication: CiRecord | null;
  derived: boolean;
  protocol: string | null;
  ports: number[];
  flows: number | null;
  confidence: number;
}

export interface ApplicationMapView {
  application: CiRecord;
  services: CiRecord[];
  tiers: Array<{ tier: string; components: ApplicationComponentView[] }>;
  placements: PlacementView[];
  dependencies: ApplicationDependencyView[];
  truncated: boolean;
  durationMs: number;
}

interface PlacementRow {
  id: string;
  parent_id: string;
  relationship: string;
  hop: number;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function int(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(n) ? n : null;
}

@Injectable()
export class ApplicationMapService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly metrics: MetricsService,
  ) {}

  async map(tenantId: string, applicationId: string): Promise<ApplicationMapView | null> {
    const started = Date.now();
    return withSpan(TRACER_NAME, 'application_map', { 'openmap.ci_id': applicationId }, async () => {
      const [application] = await this.cis.findByIds(tenantId, [applicationId]);
      if (application === undefined || application.type !== 'application') return null;
      const db = this.prisma.client;
      const componentRows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT c.id FROM relationships r JOIN cis c ON c.id = r."toCiId" AND c.type = 'application_component'::"CiType" AND c."validTo" IS NULL
        WHERE r."tenantId" = ${tenantId}::uuid AND r."fromCiId" = ${applicationId}::uuid AND r.type = 'contains'::"RelationshipType" AND r."validTo" IS NULL
        ORDER BY c.name LIMIT ${APPLICATION_MAP.maxComponents + 1}`);
      const truncated = componentRows.length > APPLICATION_MAP.maxComponents;
      const componentIds = componentRows.slice(0, APPLICATION_MAP.maxComponents).map((r) => r.id);
      const ids = componentIds.length === 0 ? [applicationId] : componentIds;
      const idList = Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
      const placementTypes = Prisma.join(APPLICATION_MAP.placementTypes.map((t) => Prisma.sql`${t}::"RelationshipType"`));
      const placements =
        componentIds.length === 0
          ? []
          : await db.$queryRaw<PlacementRow[]>(Prisma.sql`
        WITH RECURSIVE down(id, parent_id, relationship, hop) AS (
          SELECT r."toCiId", r."fromCiId", r.type::text, 1 FROM relationships r
          WHERE r."tenantId" = ${tenantId}::uuid AND r."fromCiId" IN (${idList}) AND r.type IN (${placementTypes}) AND r."validTo" IS NULL
          UNION
          SELECT r."toCiId", r."fromCiId", r.type::text, down.hop + 1 FROM relationships r JOIN down ON r."fromCiId" = down.id
          WHERE r."tenantId" = ${tenantId}::uuid AND r.type IN (${placementTypes}) AND r."validTo" IS NULL AND down.hop < ${APPLICATION_MAP.placementHops}
        ) SELECT DISTINCT id, parent_id, relationship, hop FROM down ORDER BY hop, id`);
      const dependencyTypes = Prisma.join(APPLICATION_MAP.dependencyTypes.map((t) => Prisma.sql`${t}::"RelationshipType"`));
      const edges =
        componentIds.length === 0
          ? []
          : await db.$queryRaw<Array<{ id: string; type: string; fromCiId: string; toCiId: string; attributes: Record<string, unknown>; sourceConfidence: number }>>(Prisma.sql`
        SELECT r.id, r.type::text AS type, r."fromCiId", r."toCiId", r.attributes, r."sourceConfidence"
        FROM relationships r
        WHERE r."tenantId" = ${tenantId}::uuid AND r.type IN (${dependencyTypes}) AND r."validTo" IS NULL
          AND (r."fromCiId" IN (${idList}) OR r."toCiId" IN (${idList}))`);
      const farIds = [...new Set(edges.flatMap((e) => [e.fromCiId, e.toCiId]))].filter((id) => !componentIds.includes(id));
      const owners =
        farIds.length === 0
          ? []
          : await db.$queryRaw<Array<{ componentId: string; applicationId: string }>>(Prisma.sql`
        SELECT r."toCiId" AS "componentId", r."fromCiId" AS "applicationId" FROM relationships r
        JOIN cis a ON a.id = r."fromCiId" AND a.type = 'application'::"CiType" AND a."validTo" IS NULL
        WHERE r."tenantId" = ${tenantId}::uuid AND r.type = 'contains'::"RelationshipType" AND r."validTo" IS NULL
          AND r."toCiId" IN (${Prisma.join(farIds.map((id) => Prisma.sql`${id}::uuid`))})`);
      const applicationOf = new Map(owners.map((o) => [o.componentId, o.applicationId]));
      const serviceRows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT r."toCiId" AS id FROM relationships r
        WHERE r."tenantId" = ${tenantId}::uuid AND r."fromCiId" = ${applicationId}::uuid AND r.type = 'part_of_service'::"RelationshipType" AND r."validTo" IS NULL`);

      const edgeRows: EdgeRow[] = edges.map((e) => ({ id: e.id, type: e.type, fromId: e.fromCiId, toId: e.toCiId, attributes: e.attributes, confidence: e.sourceConfidence }));
      const classified = classifyDependencies(edgeRows, new Set(componentIds), applicationOf);
      const allIds = [...new Set([...componentIds, ...placements.map((p) => p.id), ...farIds, ...owners.map((o) => o.applicationId), ...serviceRows.map((s) => s.id)])];
      const resolved = new Map((await this.cis.findByIds(tenantId, allIds)).map((ci) => [ci.id, ci]));

      const components: Array<ApplicationComponentView & { id: string; name: string }> = componentIds.flatMap((id) => {
        const ci = resolved.get(id);
        if (ci === undefined) return [];
        const a = ci.attributes;
        return [{ id, name: ci.name, ci, tier: str(a['tier']) ?? ci.type, technology: str(a['technology']), protocol: str(a['protocol']), port: int(a['port']), deployment: str(a['deployment']), instances: int(a['instances']) }];
      });
      const tiers = groupTiers(components).map((t) => ({ tier: t.tier, components: t.components.map(({ id: _id, name: _name, ...view }) => view) }));
      const placementViews: PlacementView[] = placements.flatMap((p) => {
        const ci = resolved.get(p.id);
        return ci === undefined ? [] : [{ ci, parentId: p.parent_id, relationship: p.relationship, hop: p.hop }];
      });
      const dependencies: ApplicationDependencyView[] = classified.flatMap((d) => {
        const from = resolved.get(d.fromId);
        const to = resolved.get(d.toId);
        if (from === undefined || to === undefined) return [];
        return [{ id: d.id, from, to, type: d.type, direction: d.direction, otherApplication: d.otherApplicationId === null ? null : (resolved.get(d.otherApplicationId) ?? null), derived: d.derived, protocol: d.protocol, ports: d.ports, flows: d.flows, confidence: d.confidence }];
      });
      const services = serviceRows.flatMap((s) => {
        const ci = resolved.get(s.id);
        return ci === undefined ? [] : [ci];
      });
      const durationMs = Date.now() - started;
      this.metrics.applicationMapDuration.observe(durationMs / TIME.msPerSecond);
      return { application, services, tiers, placements: placementViews, dependencies, truncated, durationMs };
    });
  }
}
