// REQ-SEC-012 (ADR-070) — the facts the compliance checks read, gathered from what OpenMap already stores: CVE
// exposure through software_instance —installed_on→ CI and software —affected_by→ vulnerability (ADR-013), operating
// systems with their host and last patch, hardware end of support from the asset register, TLS listeners, stores
// that report encryption at rest, NAS shares, object buckets, databases with their last backup, and firewall rule
// bases with their analysis (ADR-064). One set-based query per fact family, so a 100k-CI estate is a few round trips.
import { Inject, Injectable } from '@nestjs/common';
import { FIREWALL } from '@openmap/constants';
import {
  CI_TYPE_LAYER,
  analyseFirewall,
  ciTypeSchema,
  endOfLifeSchema,
  firewallRuleFromAttributes,
  type CiLayer,
  type CveFact,
  type FirewallRuleView,
} from '@openmap/contracts';
import { Prisma } from '@openmap/db';
import { asRecord, booleanAttribute, numberAttribute, stringArrayAttribute, stringAttribute } from '../common/validation.js';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import { PrismaService } from '../db/prisma.service.js';
import { toVulnerabilitySummary } from '../software/software.service.js';

/** Physical equipment the asset register tracks end of support for. */
const HARDWARE_LAYERS: ReadonlySet<CiLayer> = new Set<CiLayer>(['dc', 'network_security', 'hardware', 'storage']);

export interface ExposureFact {
  ciId: string;
  /** Distinct software products installed on the CI. */
  installed: number;
  cves: CveFact[];
}

export interface OsFact {
  ciId: string;
  lastPatchedAt: string | null;
  hostId: string | null;
}

export interface HardwareFact {
  ciId: string;
  endOfSupport: string | null;
  source: string | null;
}

export interface TlsFact {
  ciId: string;
  tlsVersion: string | null;
  endpoint: string | null;
}

export interface StorageFact {
  ciId: string;
  attributes: Record<string, unknown>;
}

export interface ShareFact {
  ciId: string;
  protocol: string | null;
  options: string[];
}

export interface BucketFact {
  ciId: string;
  publicAccessBlocked: boolean | null;
}

export interface DatabaseFact {
  ciId: string;
  lastBackupAt: string | null;
}

export interface FirewallFact {
  ciId: string;
  rules: number;
  permissive: number;
  truncated: boolean;
}

interface ExposureRow {
  ci: string;
  installed: number;
  vulns: string[];
}

interface OsRow {
  id: string;
  lastPatchedAt: string | null;
  host: string | null;
}

interface AttrRow {
  id: string;
  type: string;
  attributes: Prisma.JsonValue;
}

interface RuleRow {
  device: string;
  id: string;
  name: string;
  attributes: Prisma.JsonValue;
}

@Injectable()
export class ComplianceFactsRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
  ) {}

  /** CIs with discovered software, how many products each runs, and the CVEs affecting those products. */
  async exposure(tenantId: string): Promise<ExposureFact[]> {
    const vulns = await this.cis.byType(tenantId, 'vulnerability');
    const rows = await this.prisma.client.$queryRaw<ExposureRow[]>(Prisma.sql`
        WITH inv AS (
          SELECT ins."toCiId" AS ci, mem."toCiId" AS software
          FROM relationships ins
          JOIN relationships mem ON mem."fromCiId" = ins."fromCiId" AND mem.type = 'member_of' AND mem."validTo" IS NULL
            AND mem."tenantId" = ${tenantId}::uuid
          JOIN cis host ON host.id = ins."toCiId" AND host."validTo" IS NULL
          WHERE ins."tenantId" = ${tenantId}::uuid AND ins.type = 'installed_on' AND ins."validTo" IS NULL
        )
        SELECT inv.ci::text AS ci, count(DISTINCT inv.software)::int AS installed,
               coalesce(array_agg(DISTINCT aff."toCiId"::text) FILTER (WHERE aff."toCiId" IS NOT NULL), '{}') AS vulns
        FROM inv
        LEFT JOIN relationships aff ON aff."fromCiId" = inv.software AND aff.type = 'affected_by' AND aff."validTo" IS NULL
          AND aff."tenantId" = ${tenantId}::uuid
        GROUP BY inv.ci`);
    const cveOf = new Map<string, CveFact>();
    for (const v of vulns) {
      const s = toVulnerabilitySummary(v, 0, 0, false);
      cveOf.set(v.id, { cveId: s.cveId, severity: s.severity, cvss: s.cvss, exploited: s.exploited || s.cisaKev });
    }
    return rows.map((r) => ({
      ciId: r.ci,
      installed: r.installed,
      cves: r.vulns.map((id) => cveOf.get(id)).filter((c): c is CveFact => c !== undefined),
    }));
  }

  /** Every operating system with its last patch date and the host or VM it is installed on. */
  async operatingSystems(tenantId: string): Promise<OsFact[]> {
    const rows = await this.prisma.client.$queryRaw<OsRow[]>(Prisma.sql`
      SELECT DISTINCT ON (c.id) c.id::text AS id, c.attributes->>'lastPatchedAt' AS "lastPatchedAt", r."toCiId"::text AS host
      FROM cis c
      LEFT JOIN relationships r ON r."fromCiId" = c.id AND r.type = 'installed_on' AND r."validTo" IS NULL
      WHERE c."tenantId" = ${tenantId}::uuid AND c.type = 'operating_system' AND c."validTo" IS NULL
      ORDER BY c.id, r."validFrom" DESC`);
    return rows.map((r) => ({ ciId: r.id, lastPatchedAt: r.lastPatchedAt, hostId: r.host }));
  }

  /** Physical equipment in the asset register that is linked to a CI, with its recorded end of support. */
  async hardware(tenantId: string): Promise<HardwareFact[]> {
    const assets = await this.prisma.client.assetRecord.findMany({
      where: { tenantId, ciId: { not: null } },
      select: { ciId: true, ciType: true, endOfLife: true },
      orderBy: { assetTag: 'asc' },
    });
    const out: HardwareFact[] = [];
    const seen = new Set<string>();
    for (const a of assets) {
      const type = ciTypeSchema.safeParse(a.ciType);
      if (a.ciId === null || !type.success || !HARDWARE_LAYERS.has(CI_TYPE_LAYER[type.data]) || seen.has(a.ciId)) continue;
      seen.add(a.ciId);
      const eol = endOfLifeSchema.safeParse(a.endOfLife);
      out.push({
        ciId: a.ciId,
        endOfSupport: eol.success ? eol.data.endOfSupport : null,
        source: eol.success ? eol.data.source : null,
      });
    }
    return out;
  }

  private async byTypes(tenantId: string, types: readonly string[], where: Prisma.Sql): Promise<AttrRow[]> {
    return this.prisma.client.$queryRaw<AttrRow[]>(Prisma.sql`
      SELECT id::text AS id, type::text AS type, attributes FROM cis
      WHERE "tenantId" = ${tenantId}::uuid AND "validTo" IS NULL AND type::text IN (${Prisma.join([...types])}) AND ${where}
      ORDER BY id`);
  }

  /** Listeners the certificate collector saw speak TLS, with the protocol they negotiated. */
  async tlsListeners(tenantId: string): Promise<TlsFact[]> {
    const rows = await this.byTypes(tenantId, ['listening_service'], Prisma.sql`attributes->'tls' = 'true'::jsonb`);
    return rows.map((r) => {
      const a = asRecord(r.attributes);
      const host = stringAttribute(a, 'serverName') ?? stringAttribute(a, 'target');
      const port = numberAttribute(a, 'port');
      return {
        ciId: r.id,
        tlsVersion: stringAttribute(a, 'tlsVersion'),
        endpoint: host === null ? null : port === null ? host : host + ':' + String(port),
      };
    });
  }

  /** Stores that report encryption at rest: a boolean `encryptionAtRest`, or an object bucket's `encryption`. */
  async storage(tenantId: string): Promise<StorageFact[]> {
    const rows = await this.prisma.client.$queryRaw<AttrRow[]>(Prisma.sql`
      SELECT id::text AS id, type::text AS type,
             jsonb_strip_nulls(jsonb_build_object('encryptionAtRest', attributes->'encryptionAtRest', 'encryption', attributes->'encryption')) AS attributes
      FROM cis
      WHERE "tenantId" = ${tenantId}::uuid AND "validTo" IS NULL
        AND (attributes ? 'encryptionAtRest' OR (type = 'object_bucket' AND attributes ? 'encryption'))
      ORDER BY id`);
    return rows.map((r) => ({ ciId: r.id, attributes: asRecord(r.attributes) }));
  }

  async shares(tenantId: string): Promise<ShareFact[]> {
    const rows = await this.byTypes(tenantId, ['nas_share'], Prisma.sql`TRUE`);
    return rows.map((r) => {
      const a = asRecord(r.attributes);
      return { ciId: r.id, protocol: stringAttribute(a, 'protocol'), options: stringArrayAttribute(a, 'options') };
    });
  }

  async buckets(tenantId: string): Promise<BucketFact[]> {
    const rows = await this.byTypes(tenantId, ['object_bucket'], Prisma.sql`attributes ? 'publicAccessBlocked'`);
    return rows.map((r) => ({ ciId: r.id, publicAccessBlocked: booleanAttribute(asRecord(r.attributes), 'publicAccessBlocked') }));
  }

  async databases(tenantId: string): Promise<DatabaseFact[]> {
    const rows = await this.byTypes(tenantId, ['database'], Prisma.sql`TRUE`);
    return rows.map((r) => ({ ciId: r.id, lastBackupAt: stringAttribute(asRecord(r.attributes), 'lastBackupAt') }));
  }

  /** Each device that contains firewall rules: how many rules and how many the analysis calls permissive. */
  async firewalls(tenantId: string): Promise<FirewallFact[]> {
    const rows = await this.prisma.client.$queryRaw<RuleRow[]>(Prisma.sql`
      SELECT r."fromCiId"::text AS device, c.id::text AS id, c.name, c.attributes
      FROM relationships r
      JOIN cis c ON c.id = r."toCiId" AND c."validTo" IS NULL AND c.type = 'firewall_rule'
      JOIN cis d ON d.id = r."fromCiId" AND d."validTo" IS NULL
      WHERE r."tenantId" = ${tenantId}::uuid AND r.type = 'contains' AND r."validTo" IS NULL
      ORDER BY r."fromCiId", c.id
      LIMIT ${FIREWALL.maxRulesPerTenant}`);
    const byDevice = new Map<string, FirewallRuleView[]>();
    for (const row of rows) {
      const list = byDevice.get(row.device) ?? [];
      list.push(firewallRuleFromAttributes(row.id, row.name, asRecord(row.attributes)));
      byDevice.set(row.device, list);
    }
    return [...byDevice.entries()].map(([ciId, rules]) => {
      const analysis = analyseFirewall(rules, []);
      return {
        ciId,
        rules: rules.filter((r) => !r.isPolicy).length,
        permissive: analysis.findings.filter((f) => f.kind === 'permissive').length,
        truncated: analysis.truncated,
      };
    });
  }
}
