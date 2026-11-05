// REQ-DEP-001 (ADR-030) — Query.networkTopology: reads the current neighbour links, host cabling and device addresses
// from Postgres for a tenant (optionally one site, reached through `located_in`), folds them into a map
// (topology.ts) and resolves the nodes to CIs. One span and one histogram observation per map.
import { Inject, Injectable } from '@nestjs/common';
import { TIME, TOPOLOGY } from '@openmap/constants';
import { Prisma } from '@openmap/db';
import { withSpan } from '@openmap/telemetry';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord } from '../ci/ci.types.js';
import { PrismaService } from '../db/prisma.service.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { buildTopology, type LinkKind, type RawLink, type TopologyLayer } from './topology.js';

export interface TopologyLinkView {
  id: string;
  from: CiRecord;
  to: CiRecord;
  kind: LinkKind;
  count: number;
  ports: string[];
  protocols: string[];
  media: string[];
  speedMbps: number | null;
}

export interface NetworkTopologyView {
  layer: TopologyLayer;
  nodes: Array<{ ci: CiRecord; degree: number }>;
  links: TopologyLinkView[];
  truncated: boolean;
  durationMs: number;
}

interface Row {
  from_id: string;
  to_id: string;
  port: string | null;
  protocol: string | null;
  media: string | null;
  speed: number | null;
}

function num(value: number | string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

@Injectable()
export class TopologyService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly metrics: MetricsService,
  ) {}

  /** Device ids at a site: every device whose `located_in` chain reaches it within TOPOLOGY.siteHops. */
  private siteScope(tenantId: string, siteId: string | null): Prisma.Sql {
    if (siteId === null) return Prisma.sql`TRUE`;
    return Prisma.sql`d.id IN (
      WITH RECURSIVE up(id, hop) AS (
        SELECT ${siteId}::uuid, 0
        UNION
        SELECT r."fromCiId", up.hop + 1 FROM relationships r JOIN up ON r."toCiId" = up.id
        WHERE r."tenantId" = ${tenantId}::uuid AND r.type = 'located_in'::"RelationshipType" AND r."validTo" IS NULL AND up.hop < ${TOPOLOGY.siteHops}
      ) SELECT id FROM up)`;
  }

  private deviceTypes(): Prisma.Sql {
    return Prisma.join(TOPOLOGY.deviceTypes.map((t) => Prisma.sql`${t}::"CiType"`));
  }

  /** Device ↔ device through the LLDP/CDP neighbour link between two of their interfaces. */
  private neighbours(tenantId: string, siteId: string | null): Promise<Row[]> {
    return this.prisma.client.$queryRaw<Row[]>(Prisma.sql`
      SELECT d.id AS from_id, e.id AS to_id,
             ia.name || ' ↔ ' || ib.name AS port, n.attributes->>'protocol' AS protocol, n.attributes->>'media' AS media,
             COALESCE((n.attributes->>'speedMbps')::float8, (ia.attributes->>'ifSpeedMbps')::float8) AS speed
      FROM relationships n
      JOIN cis ia ON ia.id = n."fromCiId" AND ia.type = 'interface'::"CiType" AND ia."validTo" IS NULL
      JOIN cis ib ON ib.id = n."toCiId" AND ib.type = 'interface'::"CiType" AND ib."validTo" IS NULL
      JOIN relationships ca ON ca."toCiId" = ia.id AND ca.type = 'contains'::"RelationshipType" AND ca."validTo" IS NULL
      JOIN relationships cb ON cb."toCiId" = ib.id AND cb.type = 'contains'::"RelationshipType" AND cb."validTo" IS NULL
      JOIN cis d ON d.id = ca."fromCiId" AND d.type IN (${this.deviceTypes()}) AND d."validTo" IS NULL
      JOIN cis e ON e.id = cb."fromCiId" AND e.type IN (${this.deviceTypes()}) AND e."validTo" IS NULL
      WHERE n."tenantId" = ${tenantId}::uuid AND n.type = 'connected_to'::"RelationshipType" AND n."validTo" IS NULL
        AND ${this.siteScope(tenantId, siteId)}`);
  }

  /** Host → device through the cable from a host NIC to a device port. */
  private hosts(tenantId: string, siteId: string | null): Promise<Row[]> {
    return this.prisma.client.$queryRaw<Row[]>(Prisma.sql`
      SELECT h.id AS from_id, d.id AS to_id,
             COALESCE(c.attributes->>'hostNic', '') || ' → ' || i.name AS port, NULL AS protocol, c.attributes->>'media' AS media,
             COALESCE((c.attributes->>'speedMbps')::float8, (i.attributes->>'ifSpeedMbps')::float8) AS speed
      FROM relationships c
      JOIN cis h ON h.id = c."fromCiId" AND h.type IN (${Prisma.join(TOPOLOGY.hostTypes.map((t) => Prisma.sql`${t}::"CiType"`))}) AND h."validTo" IS NULL
      JOIN cis i ON i.id = c."toCiId" AND i.type = 'interface'::"CiType" AND i."validTo" IS NULL
      JOIN relationships ct ON ct."toCiId" = i.id AND ct.type = 'contains'::"RelationshipType" AND ct."validTo" IS NULL
      JOIN cis d ON d.id = ct."fromCiId" AND d.type IN (${this.deviceTypes()}) AND d."validTo" IS NULL
      WHERE c."tenantId" = ${tenantId}::uuid AND c.type = 'cabled_to'::"RelationshipType" AND c."validTo" IS NULL
        AND ${this.siteScope(tenantId, siteId)}`);
  }

  /** Device → subnet through an address the device (or one of its interfaces) uses. */
  private subnets(tenantId: string, siteId: string | null): Promise<Row[]> {
    return this.prisma.client.$queryRaw<Row[]>(Prisma.sql`
      SELECT d.id AS from_id, s.id AS to_id, ip.name AS port, NULL AS protocol, NULL AS media, NULL::float8 AS speed
      FROM relationships u
      JOIN cis ip ON ip.id = u."toCiId" AND ip.type = 'ip_address'::"CiType" AND ip."validTo" IS NULL
      JOIN relationships m ON m."fromCiId" = ip.id AND m.type = 'in_subnet'::"RelationshipType" AND m."validTo" IS NULL
      JOIN cis s ON s.id = m."toCiId" AND s.type = 'subnet'::"CiType" AND s."validTo" IS NULL
      LEFT JOIN relationships own ON own."toCiId" = u."fromCiId" AND own.type = 'contains'::"RelationshipType" AND own."validTo" IS NULL
      JOIN cis d ON d.id = COALESCE(CASE WHEN (SELECT type FROM cis WHERE id = u."fromCiId") = 'interface'::"CiType" THEN own."fromCiId" END, u."fromCiId")
           AND d.type IN (${this.deviceTypes()}) AND d."validTo" IS NULL
      WHERE u."tenantId" = ${tenantId}::uuid AND u.type = 'uses_ip'::"RelationshipType" AND u."validTo" IS NULL
        AND ${this.siteScope(tenantId, siteId)}`);
  }

  async topology(tenantId: string, layer: TopologyLayer, siteId: string | null, includeHosts: boolean): Promise<NetworkTopologyView> {
    const started = Date.now();
    return withSpan(TRACER_NAME, 'topology.' + layer, { 'openmap.topology.layer': layer, 'openmap.topology.hosts': includeHosts }, async () => {
      const rows =
        layer === 'l3'
          ? (await this.subnets(tenantId, siteId)).map((r) => ({ r, kind: 'subnet' as const }))
          : [
              ...(await this.neighbours(tenantId, siteId)).map((r) => ({ r, kind: 'neighbour' as const })),
              ...(includeHosts ? (await this.hosts(tenantId, siteId)).map((r) => ({ r, kind: 'host' as const })) : []),
            ];
      const raw: RawLink[] = rows.map(({ r, kind }) => ({ fromId: r.from_id, toId: r.to_id, kind, port: r.port ?? '', protocol: r.protocol, media: r.media, speedMbps: num(r.speed) }));
      const map = buildTopology(raw);
      const cis = new Map((await this.cis.findByIds(tenantId, map.nodeIds)).map((ci) => [ci.id, ci]));
      const nodes = map.nodeIds.flatMap((id) => {
        const ci = cis.get(id);
        return ci === undefined ? [] : [{ ci, degree: map.degree.get(id) ?? 0 }];
      });
      const links: TopologyLinkView[] = map.links.flatMap((l) => {
        const from = cis.get(l.fromId);
        const to = cis.get(l.toId);
        return from === undefined || to === undefined ? [] : [{ id: l.id, from, to, kind: l.kind, count: l.count, ports: l.ports, protocols: l.protocols, media: l.media, speedMbps: l.speedMbps }];
      });
      const durationMs = Date.now() - started;
      this.metrics.topologyDuration.observe({ layer }, durationMs / TIME.msPerSecond);
      return { layer, nodes, links, truncated: map.truncated, durationMs };
    });
  }
}
