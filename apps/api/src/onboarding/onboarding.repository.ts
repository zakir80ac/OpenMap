// REQ-UI-024 REQ-UI-020 — Prisma access for the initial setup (ADR-017): the organization a tenant belongs to, its
// business units, sites, inter-site links, Discovery Node registrations and the onboarding_states row.
import { Injectable, NotFoundException } from '@nestjs/common';
import { ONBOARDING_STEPS } from '@openmap/contracts';
import { Prisma } from '@openmap/db';
import { isoOf, toIso } from '../common/time.js';
import { PrismaService } from '../db/prisma.service.js';
import type { SiteInput, SiteLinkInput } from './onboarding.schemas.js';
import type { BusinessUnitView, OnboardingStep, OrganizationView, SiteLinkView, SiteView } from './onboarding.types.js';

type Tx = Prisma.TransactionClient;
type SiteRow = Prisma.SiteGetPayload<Record<string, never>>;
type LinkRow = Prisma.SiteLinkGetPayload<Record<string, never>>;
type OrganizationRow = Prisma.OrganizationGetPayload<{ include: { businessUnits: { include: { tenant: true } } } }>;

export interface OnboardingRow {
  step: OnboardingStep;
  completedSteps: OnboardingStep[];
  credentialRefs: string[];
  integrationIds: string[];
  generatedAt: string | null;
  firstSweepId: string | null;
}

const EMPTY_STATE: OnboardingRow = { step: ONBOARDING_STEPS[0], completedSteps: [], credentialRefs: [], integrationIds: [], generatedAt: null, firstSweepId: null };

export function toSite(row: SiteRow): SiteView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    code: row.code,
    name: row.name,
    kind: row.kind,
    tier: row.tier,
    address: row.address,
    city: row.city,
    countryCode: row.countryCode,
    geo: row.geoLat !== null && row.geoLon !== null ? { lat: row.geoLat, lon: row.geoLon } : null,
    cloud: row.cloudProvider !== null && row.cloudRegion !== null ? { provider: row.cloudProvider, region: row.cloudRegion } : null,
    locationCount: row.locationCount,
    facility: row.powerCapacityKw !== null && row.rackCount !== null ? { powerCapacityKw: row.powerCapacityKw, rackCount: row.rackCount, designPue: row.designPue } : null,
    drRole: row.drRole,
    criticality: row.criticality,
    ciId: row.ciId,
  };
}

export function toLink(row: LinkRow): SiteLinkView {
  return {
    id: row.id,
    fromSiteId: row.fromSiteId,
    toSiteId: row.toSiteId,
    kind: row.kind,
    provider: row.provider,
    circuitId: row.circuitId,
    bandwidthMbps: row.bandwidthMbps,
    diversePaths: row.diversePaths,
    role: row.role,
    latencyMs: row.latencyMs,
    replication: row.replication,
    probeTarget: row.probeTarget,
    ciId: row.ciId,
  };
}

function toOrganization(row: OrganizationRow): OrganizationView {
  const businessUnits: BusinessUnitView[] = row.businessUnits
    .map((bu) => ({ tenantId: bu.tenantId, name: bu.name, slug: bu.tenant.slug }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    id: row.id,
    name: row.name,
    industry: row.industry,
    timeZone: row.timeZone,
    defaultLocale: row.defaultLocale,
    regulatoryScope: row.regulatoryScope,
    airGapped: row.airGapped,
    businessUnits,
    createdAt: isoOf(row.createdAt),
  };
}

function siteData(organizationId: string, input: SiteInput): Prisma.SiteUncheckedCreateInput {
  return {
    organizationId,
    code: input.code,
    name: input.name,
    kind: input.kind,
    tier: input.tier ?? null,
    address: input.address,
    city: input.city,
    countryCode: input.countryCode,
    geoLat: input.geo?.lat ?? null,
    geoLon: input.geo?.lon ?? null,
    cloudProvider: input.cloud?.provider ?? null,
    cloudRegion: input.cloud?.region ?? null,
    locationCount: input.locationCount,
    powerCapacityKw: input.facility?.powerCapacityKw ?? null,
    rackCount: input.facility?.rackCount ?? null,
    designPue: input.facility?.designPue ?? null,
    drRole: input.drRole ?? 'none',
    criticality: input.criticality ?? null,
  };
}

@Injectable()
export class OnboardingRepository {
  constructor(private readonly prisma: PrismaService) {}

  private get db() {
    return this.prisma.client;
  }

  /** The organization the caller's tenant belongs to; every tenant has one (migration 0005 seeds the first). */
  async organizationIdOf(tenantId: string): Promise<string> {
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId }, select: { organizationId: true } });
    if (!tenant) throw new NotFoundException('tenant ' + tenantId + ' not found');
    return tenant.organizationId;
  }

  async organization(organizationId: string): Promise<OrganizationView> {
    const row = await this.db.organization.findUnique({ where: { id: organizationId }, include: { businessUnits: { include: { tenant: true } } } });
    if (!row) throw new NotFoundException('organization ' + organizationId + ' not found');
    return toOrganization(row);
  }

  /** Tenants of the organization that have no business unit row yet (the bootstrap tenant, replayed tenants). */
  async tenantsWithoutUnit(organizationId: string): Promise<Array<{ id: string; name: string; slug: string }>> {
    return this.db.tenant.findMany({ where: { organizationId, businessUnit: null }, select: { id: true, name: true, slug: true }, orderBy: { createdAt: 'asc' } });
  }

  async updateOrganization(tx: Tx, organizationId: string, data: Pick<Prisma.OrganizationUncheckedUpdateInput, 'name' | 'industry' | 'timeZone' | 'defaultLocale' | 'regulatoryScope' | 'airGapped'>): Promise<void> {
    await tx.organization.update({ where: { id: organizationId }, data });
  }

  async slugTaken(tx: Tx, organizationId: string, slug: string): Promise<boolean> {
    return (await tx.tenant.count({ where: { organizationId, slug } })) > 0;
  }

  async createTenant(tx: Tx, organizationId: string, name: string, slug: string): Promise<string> {
    const tenant = await tx.tenant.create({ data: { organizationId, name, slug } });
    await tx.businessUnit.create({ data: { organizationId, tenantId: tenant.id, name } });
    return tenant.id;
  }

  async renameTenant(tx: Tx, organizationId: string, tenantId: string, name: string): Promise<void> {
    const tenant = await tx.tenant.findFirst({ where: { id: tenantId, organizationId } });
    if (!tenant) throw new NotFoundException('tenant ' + tenantId + ' is not a business unit of this organization');
    await tx.tenant.update({ where: { id: tenantId }, data: { name } });
    await tx.businessUnit.upsert({ where: { tenantId }, create: { organizationId, tenantId, name }, update: { name } });
  }

  async sites(organizationId: string): Promise<SiteView[]> {
    const rows = await this.db.site.findMany({ where: { organizationId }, orderBy: { code: 'asc' } });
    return rows.map(toSite);
  }

  async site(organizationId: string, id: string): Promise<SiteView | null> {
    const row = await this.db.site.findFirst({ where: { id, organizationId } });
    return row ? toSite(row) : null;
  }

  async siteByCode(organizationId: string, code: string): Promise<SiteView | null> {
    const row = await this.db.site.findFirst({ where: { organizationId, code } });
    return row ? toSite(row) : null;
  }

  async createSite(tx: Tx, organizationId: string, input: SiteInput): Promise<SiteView> {
    return toSite(await tx.site.create({ data: siteData(organizationId, input) }));
  }

  async updateSite(tx: Tx, organizationId: string, id: string, input: SiteInput): Promise<SiteView> {
    const { organizationId: _org, ...data } = siteData(organizationId, input);
    const row = await tx.site.update({ where: { id }, data });
    return toSite(row);
  }

  async setSiteCi(tx: Tx, id: string, ciId: string): Promise<void> {
    await tx.site.update({ where: { id }, data: { ciId } });
  }

  async siteUsage(organizationId: string, id: string): Promise<{ nodes: number; links: number }> {
    const [nodes, links] = await Promise.all([
      this.db.discoveryNode.count({ where: { siteId: id } }),
      this.db.siteLink.count({ where: { organizationId, OR: [{ fromSiteId: id }, { toSiteId: id }] } }),
    ]);
    return { nodes, links };
  }

  async deleteSite(tx: Tx, id: string): Promise<void> {
    await tx.site.delete({ where: { id } });
  }

  async links(organizationId: string): Promise<SiteLinkView[]> {
    const rows = await this.db.siteLink.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } });
    return rows.map(toLink);
  }

  async link(organizationId: string, id: string): Promise<SiteLinkView | null> {
    const row = await this.db.siteLink.findFirst({ where: { id, organizationId } });
    return row ? toLink(row) : null;
  }

  async createLink(tx: Tx, organizationId: string, input: SiteLinkInput): Promise<SiteLinkView> {
    const row = await tx.siteLink.create({
      data: { organizationId, fromSiteId: input.fromSiteId, toSiteId: input.toSiteId, kind: input.kind, provider: input.provider ?? null, circuitId: input.circuitId ?? null, bandwidthMbps: input.bandwidthMbps, diversePaths: input.diversePaths, role: input.role, latencyMs: input.latencyMs ?? null, replication: input.replication ?? false, probeTarget: input.probeTarget ?? null },
    });
    return toLink(row);
  }

  async updateLink(tx: Tx, id: string, input: SiteLinkInput): Promise<SiteLinkView> {
    const row = await tx.siteLink.update({
      where: { id },
      data: { fromSiteId: input.fromSiteId, toSiteId: input.toSiteId, kind: input.kind, provider: input.provider ?? null, circuitId: input.circuitId ?? null, bandwidthMbps: input.bandwidthMbps, diversePaths: input.diversePaths, role: input.role, latencyMs: input.latencyMs ?? null, replication: input.replication ?? false, probeTarget: input.probeTarget ?? null },
    });
    return toLink(row);
  }

  async setLinkCi(tx: Tx, id: string, ciId: string): Promise<void> {
    await tx.siteLink.update({ where: { id }, data: { ciId } });
  }

  async deleteLink(tx: Tx, id: string): Promise<void> {
    await tx.siteLink.delete({ where: { id } });
  }

  /** Registers or re-registers a Node: pending again with a new token digest, certificate facts cleared. */
  async registerNode(tenantId: string, siteId: string, nodeId: string, tokenDigest: string): Promise<void> {
    await this.db.discoveryNode.upsert({
      where: { id: nodeId },
      update: { status: 'pending', enrolTokenDigest: tokenDigest, siteId, tenantId, enrolledAt: null, certificateSerial: null, certificateFingerprint: null, certificateExpiresAt: null },
      create: { id: nodeId, tenantId, siteId, status: 'pending', enrolTokenDigest: tokenDigest, collectorIds: [] },
    });
  }

  async state(organizationId: string): Promise<OnboardingRow> {
    const row = await this.db.onboardingState.findUnique({ where: { organizationId } });
    if (!row) return { ...EMPTY_STATE };
    return {
      step: row.step,
      completedSteps: row.completedSteps,
      credentialRefs: row.credentialRefs,
      integrationIds: row.integrationIds,
      generatedAt: toIso(row.generatedAt),
      firstSweepId: row.firstSweepId,
    };
  }

  async saveState(organizationId: string, patch: Partial<OnboardingRow>, tx: Tx | null = null): Promise<OnboardingRow> {
    const client = tx ?? this.db;
    const current = await this.state(organizationId);
    const next: OnboardingRow = { ...current, ...patch };
    await client.onboardingState.upsert({
      where: { organizationId },
      create: { organizationId, step: next.step, completedSteps: next.completedSteps, credentialRefs: next.credentialRefs, integrationIds: next.integrationIds, seedImports: [], generatedAt: next.generatedAt === null ? null : new Date(next.generatedAt), firstSweepId: next.firstSweepId },
      update: { step: next.step, completedSteps: next.completedSteps, credentialRefs: next.credentialRefs, integrationIds: next.integrationIds, generatedAt: next.generatedAt === null ? null : new Date(next.generatedAt), firstSweepId: next.firstSweepId },
    });
    return next;
  }
}
