// REQ-UI-024 REQ-UI-020 — the initial setup (ADR-017). Six steps, each a real write: the organization and its
// business units become tenants; a saved site becomes a site CI through the outbox (so the graph, ClickHouse and
// search follow); a link becomes a site_link CI connected to both site CIs; a Node registration mints the one-time
// enrolment token the scheduler's /v1/nodes/enrol expects; a credential set is written to OpenBao and only its
// reference is kept; a scope is a subnet CI located at its site, which the planner turns into jobs; generating the
// twin records the moment and starts the first sweep. Nothing here is a draft the user has to re-enter elsewhere.
import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { IPV4, PKI, RECONCILIATION, SETUP_PATTERNS } from '@openmap/constants';
import { CONNECTIVITY_ATTRIBUTES, CREDENTIAL_FIELDS, ONBOARDING_STEPS } from '@openmap/contracts';
import { CI_REPOSITORY, type CiRepository, type NewCi } from '../ci/ci.repository.js';
import type { Actor } from '../ci/ci.service.js';
import { checksumOf } from '../ci/checksum.js';
import type { CiRecord } from '../ci/ci.types.js';
import { nowIso } from '../common/time.js';
import { ENV, type Env } from '../config/env.module.js';
import { DiscoveryService, LOCATED_IN, SCOPE_ATTRIBUTES, toScopeView } from '../discovery/discovery.service.js';
import type { DiscoveryScopeView } from '../discovery/discovery.types.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import { SecretsService } from '../integrations/secrets.service.js';
import { OutboxService, type OutboxTransaction } from '../outbox/outbox.service.js';
import { OnboardingRepository } from './onboarding.repository.js';
import type { CredentialSetInput, OrganizationInput, ScopeInput, SiteInput, SiteLinkInput } from './onboarding.schemas.js';
import type { CredentialSetView, NodeRegistrationView, OnboardingStateView, OnboardingStep, OrganizationView, SiteLinkView, SiteView } from './onboarding.types.js';

/** Provenance run id of everything the wizard writes: one id per organization, so the twin's origin reads as one run. */
function setupRunId(organizationId: string): string {
  return organizationId;
}

/** The scheduler stores the SHA-256 of the token (apps/scheduler/src/server/app.ts tokenDigest). */
export function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** URL-safe tenant slug from a business unit name; the directory resolves Keycloak tenant claims by it. */
export function slugOf(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(SETUP_PATTERNS.slugSeparator, '-')
    .replace(/^-+|-+$/gu, '');
  return slug.length > 0 ? slug : 'unit';
}

/** Relationship type between a site_link CI and the two site CIs it joins (as the estate generator records it). */
const CONNECTED_TO = 'connected_to';
const CONNECTED_TO_ENDS = ['A', 'Z'] as const;

function siteAttributes(site: SiteView, timeZone: string): Record<string, unknown> {
  return {
    kind: site.kind,
    tier: site.tier,
    city: site.city,
    countryCode: site.countryCode,
    address: site.address,
    latitude: site.geo?.lat ?? null,
    longitude: site.geo?.lon ?? null,
    locationCount: site.locationCount,
    cloudProvider: site.cloud?.provider ?? null,
    cloudRegion: site.cloud?.region ?? null,
    powerCapacityKw: site.facility?.powerCapacityKw ?? null,
    rackCount: site.facility?.rackCount ?? null,
    designPue: site.facility?.designPue ?? null,
    drRole: site.drRole,
    criticality: site.criticality,
    timeZone,
  };
}

function linkAttributes(link: SiteLinkView): Record<string, unknown> {
  return {
    kind: link.kind,
    provider: link.provider,
    bandwidthMbps: link.bandwidthMbps,
    diversePaths: link.diversePaths,
    role: link.role,
    latencyMs: link.latencyMs,
    replication: link.replication,
    ...(link.probeTarget === null ? {} : { probeTarget: link.probeTarget }),
    // ADR-069 (REQ-IPAM-007): the circuit register's fields, which the readiness rules read on the CI.
    [CONNECTIVITY_ATTRIBUTES.carrierContractRef]: link.carrierContractRef,
    [CONNECTIVITY_ATTRIBUTES.slaLatencyMs]: link.slaLatencyMs,
    [CONNECTIVITY_ATTRIBUTES.pathRef]: link.pathRef,
    status: 'planned',
  };
}

function linkName(from: SiteView, to: SiteView, link: SiteLinkView): string {
  return from.code + ' to ' + to.code + ' ' + link.kind.replace(/_/gu, ' ') + ' (' + link.role + ')';
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly repo: OnboardingRepository,
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly outbox: OutboxService,
    private readonly discovery: DiscoveryService,
    private readonly secrets: SecretsService,
    private readonly integrations: IntegrationsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  organizationIdOf(tenantId: string): Promise<string> {
    return this.repo.organizationIdOf(tenantId);
  }

  async state(tenantId: string): Promise<OnboardingStateView> {
    const organizationId = await this.repo.organizationIdOf(tenantId);
    const [organization, row] = await Promise.all([this.organization(organizationId), this.repo.state(organizationId)]);
    return { organization, ...row, schedulerUrl: this.env.PUBLIC_SCHEDULER_URL };
  }

  /** Tenants without a business unit row (the bootstrap tenant) are listed as units too, so the wizard can rename them. */
  private async organization(organizationId: string): Promise<OrganizationView> {
    const view = await this.repo.organization(organizationId);
    const missing = await this.repo.tenantsWithoutUnit(organizationId);
    return { ...view, businessUnits: [...view.businessUnits, ...missing.map((t) => ({ tenantId: t.id, name: t.name, slug: t.slug }))] };
  }

  sites(organizationId: string): Promise<SiteView[]> {
    return this.repo.sites(organizationId);
  }

  async site(organizationId: string, id: string): Promise<SiteView> {
    const site = await this.repo.site(organizationId, id);
    if (!site) throw new NotFoundException('site ' + id + ' not found');
    return site;
  }

  links(organizationId: string): Promise<SiteLinkView[]> {
    return this.repo.links(organizationId);
  }

  async updateOrganization(actor: Actor, input: OrganizationInput): Promise<OrganizationView> {
    const organizationId = await this.repo.organizationIdOf(actor.tenantId);
    await this.outbox.transaction(actor.tenantId, async ({ tx }) => {
      await this.repo.updateOrganization(tx, organizationId, { name: input.name, industry: input.industry, timeZone: input.timeZone, defaultLocale: input.defaultLocale, regulatoryScope: input.regulatoryScope, airGapped: input.airGapped });
      for (const unit of input.businessUnits) {
        if (unit.tenantId !== null && unit.tenantId !== undefined) {
          await this.repo.renameTenant(tx, organizationId, unit.tenantId, unit.name);
          continue;
        }
        let slug = slugOf(unit.name);
        for (let n = 1; await this.repo.slugTaken(tx, organizationId, slug); n++) slug = slugOf(unit.name) + '-' + String(n + 1);
        await this.repo.createTenant(tx, organizationId, unit.name, slug);
      }
    });
    await this.repo.saveState(organizationId, { completedSteps: await this.completed(organizationId, 'organization') });
    return this.organization(organizationId);
  }

  private async completed(organizationId: string, step: OnboardingStep): Promise<OnboardingStep[]> {
    const current = await this.repo.state(organizationId);
    return current.completedSteps.includes(step) ? current.completedSteps : [...current.completedSteps, step];
  }

  async upsertSite(actor: Actor, id: string | null, input: SiteInput): Promise<SiteView> {
    const organizationId = await this.repo.organizationIdOf(actor.tenantId);
    const organization = await this.repo.organization(organizationId);
    if (input.kind === 'cloud_region' && (input.cloud === null || input.cloud === undefined)) throw new BadRequestException('a cloud region needs its provider and region');
    const taken = await this.repo.siteByCode(organizationId, input.code);
    if (taken !== null && taken.id !== id) throw new BadRequestException('site code ' + input.code + ' is already used by ' + taken.name);
    return this.outbox.transaction(actor.tenantId, async (ctx) => {
      let site: SiteView;
      if (id === null) {
        site = await this.repo.createSite(ctx.tx, organizationId, input);
      } else {
        const existing = await this.repo.site(organizationId, id);
        if (!existing) throw new NotFoundException('site ' + id + ' not found');
        if (existing.code !== input.code) throw new BadRequestException('a site code cannot change: it is the identity of the site CI');
        site = await this.repo.updateSite(ctx.tx, organizationId, id, input);
      }
      const ci = await this.ensureSiteCi(ctx, actor.tenantId, organizationId, site, organization.timeZone);
      return { ...site, ciId: ci.id };
    });
  }

  /** Creates the site CI (identity: the code) or brings its attributes up to date; returns the current CI. */
  private async ensureSiteCi(ctx: OutboxTransaction, tenantId: string, organizationId: string, site: SiteView, timeZone: string): Promise<CiRecord> {
    const attributes = siteAttributes(site, timeZone);
    const existing = site.ciId === null ? await this.cis.findCurrentByIdentity(tenantId, 'site', { code: site.code }) : await this.cis.findById(tenantId, site.ciId, null);
    if (existing !== null) {
      if (site.ciId === null) await this.repo.setSiteCi(ctx.tx, site.id, existing.id);
      const merged = { ...existing.attributes, ...attributes };
      if (checksumOf(existing.type, existing.identity, merged) === existing.checksum) return existing;
      const updated = await this.cis.updateAttributes(ctx.tx, tenantId, existing.id, merged, checksumOf(existing.type, existing.identity, merged));
      await ctx.emit({ type: 'openmap.ci.updated', subject: updated.id, data: { ci: updated, changedKeys: Object.keys(attributes) } });
      return updated;
    }
    const created = await this.createCi(ctx, tenantId, { type: 'site', identity: { code: site.code }, name: site.name, attributes, tags: ['site', site.kind], lifecycle: 'managed', runId: setupRunId(organizationId), confidence: RECONCILIATION.userLabelConfidence });
    await this.repo.setSiteCi(ctx.tx, site.id, created.id);
    return created;
  }

  private async createCi(ctx: OutboxTransaction, tenantId: string, input: NewCi): Promise<CiRecord> {
    const ci = await this.cis.create(ctx.tx, tenantId, input);
    await ctx.emit({ type: 'openmap.ci.created', subject: ci.id, data: { ci } });
    return ci;
  }

  private async relate(ctx: OutboxTransaction, tenantId: string, organizationId: string, type: typeof LOCATED_IN | typeof CONNECTED_TO, fromCiId: string, toCiId: string, attributes: Record<string, unknown>): Promise<void> {
    const rel = await this.cis.createRelationship(ctx.tx, tenantId, { type, fromCiId, toCiId, attributes, runId: setupRunId(organizationId), confidence: RECONCILIATION.userLabelConfidence });
    await ctx.emit({ type: 'openmap.relationship.created', subject: rel.id, data: { relationship: rel } });
  }

  async removeSite(actor: Actor, id: string): Promise<boolean> {
    const organizationId = await this.repo.organizationIdOf(actor.tenantId);
    const site = await this.site(organizationId, id);
    const usage = await this.repo.siteUsage(organizationId, id);
    if (usage.nodes > 0 || usage.links > 0) throw new BadRequestException('remove the site\'s Nodes and links first');
    await this.outbox.transaction(actor.tenantId, async (ctx) => {
      if (site.ciId !== null) {
        const retired = await this.cis.retire(ctx.tx, actor.tenantId, site.ciId);
        await ctx.emit({ type: 'openmap.ci.retired', subject: retired.id, data: { ci: retired } });
      }
      await this.repo.deleteSite(ctx.tx, id);
    });
    return true;
  }

  async upsertSiteLink(actor: Actor, id: string | null, input: SiteLinkInput): Promise<SiteLinkView> {
    const organizationId = await this.repo.organizationIdOf(actor.tenantId);
    if (input.fromSiteId === input.toSiteId) throw new BadRequestException('a link joins two different sites');
    const [from, to] = await Promise.all([this.site(organizationId, input.fromSiteId), this.site(organizationId, input.toSiteId)]);
    return this.outbox.transaction(actor.tenantId, async (ctx) => {
      let link: SiteLinkView;
      if (id === null) {
        link = await this.repo.createLink(ctx.tx, organizationId, input);
      } else {
        const existing = await this.repo.link(organizationId, id);
        if (!existing) throw new NotFoundException('link ' + id + ' not found');
        link = await this.repo.updateLink(ctx.tx, id, input);
      }
      const ci = await this.ensureLinkCi(ctx, actor.tenantId, organizationId, link, from, to);
      return { ...link, ciId: ci.id };
    });
  }

  private async ensureLinkCi(ctx: OutboxTransaction, tenantId: string, organizationId: string, link: SiteLinkView, from: SiteView, to: SiteView): Promise<CiRecord> {
    const attributes = linkAttributes(link);
    const existing = link.ciId === null ? null : await this.cis.findById(tenantId, link.ciId, null);
    if (existing !== null) {
      const merged = { ...existing.attributes, ...attributes };
      if (checksumOf(existing.type, existing.identity, merged) === existing.checksum) return existing;
      const updated = await this.cis.updateAttributes(ctx.tx, tenantId, existing.id, merged, checksumOf(existing.type, existing.identity, merged));
      await ctx.emit({ type: 'openmap.ci.updated', subject: updated.id, data: { ci: updated, changedKeys: Object.keys(attributes) } });
      return updated;
    }
    if (from.ciId === null || to.ciId === null) throw new BadRequestException('both sites need their CI before a link can be created');
    const created = await this.createCi(ctx, tenantId, {
      type: 'site_link',
      identity: { circuitId: link.circuitId ?? link.id, fromSiteRef: from.code, toSiteRef: to.code },
      name: linkName(from, to, link),
      attributes,
      tags: ['wan', link.kind],
      lifecycle: 'managed',
      runId: setupRunId(organizationId),
      confidence: RECONCILIATION.userLabelConfidence,
    });
    await this.repo.setLinkCi(ctx.tx, link.id, created.id);
    await this.relate(ctx, tenantId, organizationId, CONNECTED_TO, created.id, from.ciId, { end: CONNECTED_TO_ENDS[0] });
    await this.relate(ctx, tenantId, organizationId, CONNECTED_TO, created.id, to.ciId, { end: CONNECTED_TO_ENDS[1] });
    return created;
  }

  async removeSiteLink(actor: Actor, id: string): Promise<boolean> {
    const organizationId = await this.repo.organizationIdOf(actor.tenantId);
    const link = await this.repo.link(organizationId, id);
    if (!link) throw new NotFoundException('link ' + id + ' not found');
    await this.outbox.transaction(actor.tenantId, async (ctx) => {
      if (link.ciId !== null) {
        const retired = await this.cis.retire(ctx.tx, actor.tenantId, link.ciId);
        await ctx.emit({ type: 'openmap.ci.retired', subject: retired.id, data: { ci: retired } });
      }
      await this.repo.deleteLink(ctx.tx, id);
    });
    return true;
  }

  async registerNode(actor: Actor, siteId: string, nodeId: string): Promise<NodeRegistrationView> {
    const organizationId = await this.repo.organizationIdOf(actor.tenantId);
    const site = await this.site(organizationId, siteId);
    const token = randomBytes(PKI.enrolTokenBytes).toString('hex');
    await this.repo.registerNode(actor.tenantId, siteId, nodeId, tokenDigest(token));
    const node = (await this.discovery.nodes(actor.tenantId)).find((n) => n.id === nodeId);
    if (node === undefined) throw new NotFoundException('node ' + nodeId + ' was not registered');
    return { node, siteCode: site.code, enrolToken: token, schedulerUrl: this.env.PUBLIC_SCHEDULER_URL };
  }

  async saveCredentialSet(actor: Actor, input: CredentialSetInput): Promise<CredentialSetView> {
    const organizationId = await this.repo.organizationIdOf(actor.tenantId);
    const fields: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.fields)) if (value.trim() !== '') fields[name] = value;
    await this.secrets.write(input.ref, { type: input.type, ...fields });
    const current = await this.repo.state(organizationId);
    const refs = current.credentialRefs.includes(input.ref) ? current.credentialRefs : [...current.credentialRefs, input.ref];
    await this.repo.saveState(organizationId, { credentialRefs: refs });
    return { ref: input.ref, type: input.type, fields: Object.keys(fields) };
  }

  /** Field names only: the vault answers with values, and they stop here. A reference the vault no longer holds reads as type none. */
  async credentials(refs: readonly string[]): Promise<CredentialSetView[]> {
    const out: CredentialSetView[] = [];
    for (const ref of refs) {
      const record = await this.secrets.describe(ref);
      if (record === null) {
        out.push({ ref, type: 'none', fields: [] });
        continue;
      }
      const known = record.type !== null && Object.keys(CREDENTIAL_FIELDS).includes(record.type) ? record.type : 'none';
      out.push({ ref, type: known, fields: record.fields.filter((n) => n !== 'type' && n !== 'expiresAt').sort() });
    }
    return out;
  }

  async addDiscoveryScope(actor: Actor, input: ScopeInput): Promise<DiscoveryScopeView> {
    const organizationId = await this.repo.organizationIdOf(actor.tenantId);
    const site = await this.site(organizationId, input.siteId);
    if (site.ciId === null) throw new BadRequestException('site ' + site.code + ' has no CI yet; save the site first');
    const siteCiId = site.ciId;
    const prefixLength = Number(input.cidr.split('/')[1]);
    if (!Number.isInteger(prefixLength) || prefixLength > IPV4.octets * IPV4.bitsPerOctet) throw new BadRequestException('invalid prefix length in ' + input.cidr);
    const identity = { cidr: input.cidr, vrfRef: input.vrf ?? 'default' };
    const scopeAttributes: Record<string, unknown> = {};
    if (input.credentialRef !== null && input.credentialRef !== undefined) scopeAttributes[SCOPE_ATTRIBUTES.credentialRef] = input.credentialRef;
    if (input.credentialType !== null && input.credentialType !== undefined) scopeAttributes[SCOPE_ATTRIBUTES.credentialType] = input.credentialType;
    const ci = await this.outbox.transaction(actor.tenantId, async (ctx) => {
      const existing = await this.cis.findCurrentByIdentity(actor.tenantId, 'subnet', identity);
      if (existing !== null) {
        const merged = { ...existing.attributes, ...scopeAttributes };
        if (checksumOf(existing.type, existing.identity, merged) === existing.checksum) return existing;
        const updated = await this.cis.updateAttributes(ctx.tx, actor.tenantId, existing.id, merged, checksumOf(existing.type, existing.identity, merged));
        await ctx.emit({ type: 'openmap.ci.updated', subject: updated.id, data: { ci: updated, changedKeys: Object.keys(scopeAttributes) } });
        return updated;
      }
      const created = await this.createCi(ctx, actor.tenantId, {
        type: 'subnet',
        identity,
        name: input.cidr,
        attributes: { purpose: 'setup scope', prefixLength, vrf: identity.vrfRef, status: 'active', site: site.code, [SCOPE_ATTRIBUTES.exclusions]: [], ...scopeAttributes },
        tags: ['ipam', 'scope'],
        lifecycle: 'managed',
        runId: setupRunId(organizationId),
        confidence: RECONCILIATION.userLabelConfidence,
      });
      await this.relate(ctx, actor.tenantId, organizationId, LOCATED_IN, created.id, siteCiId, {});
      return created;
    });
    const view = toScopeView(ci, siteCiId);
    if (view === null) throw new BadRequestException('subnet ' + input.cidr + ' has no CIDR');
    return view;
  }

  async setStep(actor: Actor, step: OnboardingStep, completed: boolean): Promise<OnboardingStateView> {
    const organizationId = await this.repo.organizationIdOf(actor.tenantId);
    const current = await this.repo.state(organizationId);
    const completedSteps = completed ? (current.completedSteps.includes(step) ? current.completedSteps : [...current.completedSteps, step]) : current.completedSteps.filter((s) => s !== step);
    await this.repo.saveState(organizationId, { step, completedSteps });
    return this.state(actor.tenantId);
  }

  /** Every site and link has its CI (idempotent), the moment is recorded and the first sweep is planned. */
  async generateTwin(actor: Actor): Promise<OnboardingStateView> {
    const organizationId = await this.repo.organizationIdOf(actor.tenantId);
    const organization = await this.repo.organization(organizationId);
    const sites = await this.repo.sites(organizationId);
    if (sites.length === 0) throw new BadRequestException('add at least one site before generating the twin');
    await this.outbox.transaction(actor.tenantId, async (ctx) => {
      const byId = new Map<string, SiteView>();
      for (const site of sites) {
        const ci = await this.ensureSiteCi(ctx, actor.tenantId, organizationId, site, organization.timeZone);
        byId.set(site.id, { ...site, ciId: ci.id });
      }
      for (const link of await this.repo.links(organizationId)) {
        const from = byId.get(link.fromSiteId);
        const to = byId.get(link.toSiteId);
        if (from === undefined || to === undefined) continue;
        await this.ensureLinkCi(ctx, actor.tenantId, organizationId, link, from, to);
      }
    });
    const sweep = await this.discovery.runDiscovery(actor.tenantId, actor.username, null, null);
    const integrationIds = (await this.integrations.list(actor.tenantId, null)).map((i) => i.id);
    await this.repo.saveState(organizationId, { step: 'generate', completedSteps: [...ONBOARDING_STEPS], generatedAt: nowIso(), firstSweepId: sweep.id, integrationIds });
    return this.state(actor.tenantId);
  }
}
