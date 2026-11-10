// REQ-DCIM-008 (ADR-062) — cable verification and labels. Every recorded cable (ADR-056) is traced from both ends
// through the patch panels to the device ports it joins, and judged against what discovery observed: LLDP and CDP
// adjacencies between switch ports (`connected_to` interface → interface, or interface → device with the remote port
// id as the SNMP collector emits it) and server NICs seen on switch ports (`cabled_to` host → interface). Observed
// links no recorded path explains are counted, and the first CABLING.undocumentedLimit are listed with the label a
// recorded cable would get. The labels CSV prints every cable with both ends and its status.
//
// The observations are read in one SQL join (adjacency, both ends, the device that contains each interface): a tenant
// holds tens of thousands of adjacencies, more ids than a bound IN list takes.
import { Inject, Injectable } from '@nestjs/common';
import { CABLING } from '@openmap/constants';
import {
  suggestedCableLabel,
  summariseVerdicts,
  traceCable,
  verifyCabling,
  type CableEndpoint,
  type CableVerificationReason,
  type CableVerificationStatus,
  type ObservedLink,
  type PortRef,
  type RecordedPath,
  type VerificationSummary,
} from '@openmap/contracts';
import { Prisma } from '@openmap/db';
import { withSpan } from '@openmap/telemetry';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import { PrismaService } from '../db/prisma.service.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { CablingService } from './cabling.service.js';
import type { CableView, EndpointView } from './cabling.types.js';

const CSV_HEADER = ['label', 'kind', 'media', 'endA', 'endB', 'lengthM', 'colour', 'status'] as const;
const CSV_SEPARATOR = ',';
const CSV_QUOTED = new RegExp('[",\\n]');
/** How a server NIC on a switch port was seen when the collector did not say: host agents and switches both use LLDP. */
const DEFAULT_PROTOCOL = 'lldp';

export interface ObservedPortView {
  ciId: string;
  port: string | null;
}

export interface ObservedLinkView {
  a: ObservedPortView;
  b: ObservedPortView;
  protocol: string | null;
  media: string | null;
  speedMbps: number | null;
  suggestedLabel: string;
}

export interface CableVerificationItemView {
  cable: CableView;
  status: CableVerificationStatus;
  reason: CableVerificationReason;
  observed: ObservedLinkView | null;
}

export interface CablingVerificationView {
  summary: VerificationSummary;
  cables: CableVerificationItemView[];
  undocumented: ObservedLinkView[];
}

/** One observed adjacency with both ends resolved to the device and the port name on it. */
interface AdjacencyRow {
  relType: string;
  protocol: string | null;
  media: string | null;
  speedMbps: number | null;
  remotePortId: string | null;
  hostNic: string | null;
  fromId: string;
  fromIsInterface: boolean;
  fromPort: string | null;
  fromDevice: string | null;
  fromName: string;
  toId: string;
  toIsInterface: boolean;
  toPort: string | null;
  toDevice: string | null;
  toName: string;
}

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const s = String(value);
  return CSV_QUOTED.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}

@Injectable()
export class CablingVerificationService {
  constructor(
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly prisma: PrismaService,
    private readonly cabling: CablingService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Observed adjacencies as device-and-port pairs, whichever of the three collector shapes carried them, with the
   * display name of each end's device. Relationships from a cable or circuit to its ends (ADR-056, they carry `end`)
   * are what people recorded, not observations, and are left out.
   */
  private async observedLinks(
    tenantId: string,
  ): Promise<{ links: ObservedLink[]; names: Map<string, string> }> {
    const rows = await this.prisma.client.$queryRaw<AdjacencyRow[]>(Prisma.sql`
      SELECT r.type::text AS "relType",
        r.attributes->>'protocol' AS "protocol", r.attributes->>'media' AS "media",
        CASE WHEN jsonb_typeof(r.attributes->'speedMbps') = 'number' THEN (r.attributes->>'speedMbps')::float END AS "speedMbps",
        r.attributes->>'remotePortId' AS "remotePortId", r.attributes->>'hostNic' AS "hostNic",
        f.id AS "fromId", (f.type = 'interface') AS "fromIsInterface",
        coalesce(f.identity->>'name', f.attributes->>'ifDescr', f.name) AS "fromPort",
        fd.id AS "fromDevice", coalesce(fd."displayName", f."displayName") AS "fromName",
        t.id AS "toId", (t.type = 'interface') AS "toIsInterface",
        coalesce(t.identity->>'name', t.attributes->>'ifDescr', t.name) AS "toPort",
        td.id AS "toDevice", coalesce(td."displayName", t."displayName") AS "toName"
      FROM relationships r
      JOIN cis f ON f.id = r."fromCiId"
      JOIN cis t ON t.id = r."toCiId"
      LEFT JOIN relationships fo ON f.type = 'interface' AND fo."toCiId" = f.id AND fo.type = 'contains' AND fo."validTo" IS NULL
      LEFT JOIN cis fd ON fd.id = fo."fromCiId"
      LEFT JOIN relationships tw ON t.type = 'interface' AND tw."toCiId" = t.id AND tw.type = 'contains' AND tw."validTo" IS NULL
      LEFT JOIN cis td ON td.id = tw."fromCiId"
      WHERE r."tenantId" = ${tenantId}::uuid AND r."validTo" IS NULL AND r.type IN ('connected_to', 'cabled_to')
        AND NOT jsonb_exists(r.attributes, 'end')
        AND f.type NOT IN ('cable', 'circuit') AND t.type NOT IN ('cable', 'circuit')`);
    const names = new Map<string, string>();
    const links: ObservedLink[] = [];
    for (const row of rows) {
      const from: PortRef = row.fromIsInterface
        ? { ciId: row.fromDevice ?? row.fromId, port: row.fromPort }
        : { ciId: row.fromId, port: row.hostNic };
      const to: PortRef = row.toIsInterface
        ? { ciId: row.toDevice ?? row.toId, port: row.toPort }
        : { ciId: row.toId, port: row.remotePortId };
      // A device seen as a neighbour of another device with no port on either side says nothing about a cable.
      if (!row.fromIsInterface && !row.toIsInterface) continue;
      names.set(from.ciId, row.fromName);
      names.set(to.ciId, row.toName);
      links.push({
        a: from,
        b: to,
        protocol: row.protocol ?? (row.relType === 'cabled_to' ? DEFAULT_PROTOCOL : null),
        media: row.media,
        speedMbps: row.speedMbps === null ? null : Math.round(row.speedMbps),
      });
    }
    return { links, names };
  }

  /** The device port a trace from `start` reaches, or null when the path ends on a panel or does not end. */
  private farEnd(
    start: CableEndpoint,
    links: Parameters<typeof traceCable>[1],
    isPanel: (id: string) => boolean,
  ): { end: PortRef | null; complete: boolean } {
    const t = traceCable(start, links, isPanel);
    const last = t.hops.at(-1);
    if (last === undefined) return { end: null, complete: false };
    const to = last.to;
    return {
      end: isPanel(to.ciId) ? null : { ciId: to.ciId, port: to.port },
      complete: t.complete && !t.looped,
    };
  }

  async verification(tenantId: string): Promise<CablingVerificationView> {
    return withSpan(TRACER_NAME, 'cabling.verify', { 'openmap.tenant': tenantId }, async () => {
      const loaded = await this.cabling.loaded(tenantId);
      const panels = new Set(loaded.panels.map((p) => p.id));
      const isPanel = (id: string): boolean => panels.has(id);
      const paths: RecordedPath[] = loaded.cables.map((c) => {
        const towardsB = this.farEnd(c.a, loaded.links, isPanel);
        const towardsA = this.farEnd(c.b, loaded.links, isPanel);
        return {
          cableId: c.ci.id,
          a: towardsA.end,
          b: towardsB.end,
          complete: towardsA.complete && towardsB.complete,
        };
      });
      const observed = await this.observedLinks(tenantId);
      const result = verifyCabling(paths, observed.links);
      const view = (l: ObservedLink): ObservedLinkView => ({
        a: l.a,
        b: l.b,
        protocol: l.protocol,
        media: l.media,
        speedMbps: l.speedMbps,
        suggestedLabel: suggestedCableLabel(
          observed.names.get(l.a.ciId) ?? l.a.ciId,
          l.a.port,
          observed.names.get(l.b.ciId) ?? l.b.ciId,
          l.b.port,
        ),
      });
      const cableById = new Map(loaded.cables.map((c) => [c.ci.id, c]));
      const cables: CableVerificationItemView[] = [];
      for (const verdict of result.verdicts) {
        const cable = cableById.get(verdict.cableId);
        if (cable === undefined) continue;
        cables.push({
          cable,
          status: verdict.status,
          reason: verdict.reason,
          observed: verdict.observed === null ? null : view(verdict.observed),
        });
      }
      // Ordered by device and port with a plain comparison, and only the listed ones are given a label: an estate
      // with no recorded cables has every adjacency here.
      const orderKey = (l: ObservedLink): string =>
        (observed.names.get(l.a.ciId) ?? l.a.ciId) + ':' + (l.a.port ?? '');
      const undocumented = result.undocumented
        .map((l) => ({ l, key: orderKey(l) }))
        .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
        .slice(0, CABLING.undocumentedLimit)
        .map((x) => view(x.l));
      this.metrics.cablingVerifications.inc();
      return { summary: summariseVerdicts(result), cables, undocumented };
    });
  }

  /** Every cable as a label line: label, kind, media, both ends (device, port, side), length, colour, status. */
  async labelsCsv(tenantId: string): Promise<string> {
    const verification = await this.verification(tenantId);
    const endIds = [...new Set(verification.cables.flatMap((c) => [c.cable.a.ciId, c.cable.b.ciId]))];
    const names = new Map((await this.cis.findByIds(tenantId, endIds)).map((c) => [c.id, c.displayName]));
    const end = (e: EndpointView): string =>
      [names.get(e.ciId) ?? e.ciId, e.port, e.side].filter((x): x is string => x !== null).join(' ');
    const lines = [CSV_HEADER.join(CSV_SEPARATOR)];
    for (const c of verification.cables) {
      lines.push(
        [
          c.cable.label,
          c.cable.kind,
          c.cable.media,
          end(c.cable.a),
          end(c.cable.b),
          c.cable.lengthM,
          c.cable.colour,
          c.status,
        ]
          .map(csvCell)
          .join(CSV_SEPARATOR),
      );
    }
    return lines.join('\n') + '\n';
  }
}
