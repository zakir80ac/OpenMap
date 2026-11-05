// REQ-CMDB-001 — CMDB use cases: paginated and time-travel reads, search, user labelling, attribute
// edits and relationship writes. Every write goes through the outbox in one Postgres transaction.
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { RECONCILIATION } from '@openmap/constants';
import { CI_TYPE_LAYER, isOwnedCiType, type CiLayer, type RelationshipType, type UserLabel } from '@openmap/contracts';
import { ensureAssetForCi } from '../assets/assets.repository.js';
import { clampPageSize, decodeCursor, decodeIdCursor, encodeCursor } from '../common/cursor.js';
import { nowIso } from '../common/time.js';
import { booleanAttribute, numberAttribute, stringAttribute } from '../common/validation.js';
import { GraphService } from '../db/graph.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { checksumOf } from './checksum.js';
import type { CiLoaders } from './ci.loaders.js';
import { toVersion } from './ci.mapper.js';
import { CI_REPOSITORY, type CiRepository } from './ci.repository.js';
import { LAYER_PREFERENCES, type LayerPreferenceRepository } from '../graph/graph.repository.js';
import type { CiFilterInput, LabelCiInput } from './ci.schemas.js';
import type {
  CiRecord,
  CiVersionRecord,
  Connection,
  HealthState,
  Lifecycle,
  RelationshipDirection,
  RelationshipRecord,
  SearchHitRecord,
  VulnerabilityRecord,
} from './ci.types.js';

/** Relationship type from an affected CI to the vulnerability CI describing the weakness. */
export const AFFECTED_BY: RelationshipType = 'affected_by';

const HEALTH_IDS_QUERY =
  'MATCH (c:Ci {tenantId: $tenantId}) WHERE c.health IN $states AND c.validTo IS NULL RETURN c.id AS id';

export interface Actor {
  tenantId: string;
  username: string;
  requestId: string;
}

@Injectable()
export class CiService {
  constructor(
    @Inject(CI_REPOSITORY) private readonly repo: CiRepository,
    @Inject(LAYER_PREFERENCES) private readonly preferences: LayerPreferenceRepository,
    private readonly graph: GraphService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * REQ-CMDB-001…011 — the layer visibility a user toggles on the Layers screen applies to every list: without an
   * explicit `layers` filter, hidden layers are left out; an explicit filter always wins.
   */
  async withVisibleLayers(tenantId: string, userId: string, filter: CiFilterInput): Promise<CiFilterInput> {
    if (filter.layers && filter.layers.length > 0) return filter;
    const visible = await this.preferences.visibleLayers(tenantId, userId);
    return visible === null ? filter : { ...filter, layers: visible };
  }

  ci(tenantId: string, id: string, asOf: string | null): Promise<CiRecord | null> {
    return this.repo.findById(tenantId, id, asOf);
  }

  async requireCi(tenantId: string, id: string): Promise<CiRecord> {
    const ci = await this.repo.findById(tenantId, id, null);
    if (!ci) throw new NotFoundException('CI ' + id + ' not found');
    return ci;
  }

  byIds(tenantId: string, ids: readonly string[]): Promise<CiRecord[]> {
    return this.repo.findByIds(tenantId, ids);
  }

  async cis(
    tenantId: string,
    userId: string,
    requested: CiFilterInput,
    first: number | null | undefined,
    after: string | null | undefined,
    loaders: CiLoaders | null,
  ): Promise<Connection<CiRecord>> {
    const size = clampPageSize(first);
    const cursor = after ? decodeCursor(after) : null;
    const filter = await this.withVisibleLayers(tenantId, userId, requested);
    const healthIds =
      filter.health && filter.health.length > 0 ? await this.idsWithHealth(tenantId, filter.health) : null;
    const page = await this.repo.list(tenantId, filter, healthIds, size, cursor);
    if (loaders) for (const ci of page.items) loaders.ci.prime(ci.id, ci);
    const edges = page.items.map((node) => ({
      cursor: encodeCursor({ name: node.name, id: node.id }),
      node,
    }));
    const last = edges[edges.length - 1];
    return {
      edges,
      pageInfo: { endCursor: last ? last.cursor : null, hasNextPage: page.hasNextPage },
      totalCount: page.totalCount,
    };
  }

  /** The unknown layer's CIs for labelling; the explicit layer filter keeps them listed even while the layer is hidden. */
  unknownCis(
    tenantId: string,
    userId: string,
    first: number | null | undefined,
    after: string | null | undefined,
    loaders: CiLoaders | null,
  ): Promise<Connection<CiRecord>> {
    return this.cis(tenantId, userId, { types: ['unknown'], layers: ['unknown'] }, first, after, loaders);
  }

  async search(
    tenantId: string,
    text: string,
    layers: readonly CiLayer[],
    first: number | null | undefined,
  ): Promise<SearchHitRecord[]> {
    const rows = await this.repo.search(tenantId, text, layers, clampPageSize(first));
    const needle = text.toLowerCase();
    return rows
      .map((ci) => {
        const hay = ci.displayName.toLowerCase();
        const at = hay.indexOf(needle);
        const field = at >= 0 ? ci.displayName : ci.name;
        const index = at >= 0 ? at : ci.name.toLowerCase().indexOf(needle);
        // Score is the share of the matched field covered by the query, nudged up for prefix matches.
        const coverage = field.length === 0 ? 0 : Math.min(1, needle.length / field.length);
        const score = index === 0 ? Math.min(1, (coverage + 1) / (1 + 1)) : coverage;
        const highlight = index >= 0 ? field.slice(index, index + needle.length) : null;
        return { ci, score, highlight };
      })
      .sort((a, b) => b.score - a.score || a.ci.name.localeCompare(b.ci.name));
  }

  async relationships(
    tenantId: string,
    ciId: string,
    direction: RelationshipDirection,
    types: readonly RelationshipType[],
    first: number | null | undefined,
    after: string | null | undefined,
    asOf: string | null,
  ): Promise<Connection<RelationshipRecord>> {
    const size = clampPageSize(first);
    const afterId = after ? decodeIdCursor(after).id : null;
    const page = await this.repo.relationships(tenantId, {
      ciId,
      direction,
      types,
      first: size,
      afterId,
      asOf,
    });
    const edges = page.items.map((node) => ({
      cursor: encodeCursor({ name: node.type, id: node.id }),
      node,
    }));
    const last = edges[edges.length - 1];
    return {
      edges,
      pageInfo: { endCursor: last ? last.cursor : null, hasNextPage: page.hasNextPage },
      totalCount: page.totalCount,
    };
  }

  async history(
    tenantId: string,
    ciId: string,
    from: string | null,
    to: string | null,
  ): Promise<CiVersionRecord[]> {
    return (await this.repo.versions(tenantId, ciId, from, to)).map(toVersion);
  }

  async vulnerabilitiesOf(tenantId: string, ci: CiRecord): Promise<VulnerabilityRecord[]> {
    const rels = await this.repo.relationshipsOfMany(tenantId, [ci.id], [AFFECTED_BY], 'downstream');
    const vulns = await this.repo.findByIds(
      tenantId,
      rels.map((r) => r.toCiId),
    );
    return vulns.filter((v) => v.type === 'vulnerability').map((v) => toVulnerability(ci, v));
  }

  async vulnerabilities(
    tenantId: string,
    minCvss: number | null,
    internetFacing: boolean | null,
  ): Promise<VulnerabilityRecord[]> {
    const rels = await this.repo.relationshipsByType(tenantId, AFFECTED_BY);
    const ids = [...new Set(rels.flatMap((r) => [r.fromCiId, r.toCiId]))];
    const byId = new Map((await this.repo.findByIds(tenantId, ids)).map((c) => [c.id, c]));
    const out: VulnerabilityRecord[] = [];
    for (const r of rels) {
      const affected = byId.get(r.fromCiId);
      const vuln = byId.get(r.toCiId);
      if (!affected || !vuln || vuln.type !== 'vulnerability') continue;
      const v = toVulnerability(affected, vuln);
      if (minCvss !== null && v.cvss < minCvss) continue;
      if (internetFacing !== null && v.internetFacing !== internetFacing) continue;
      out.push(v);
    }
    return out.sort((a, b) => b.cvss - a.cvss);
  }

  async labelCi(actor: Actor, input: LabelCiInput): Promise<CiRecord> {
    const label: UserLabel = {
      title: input.title,
      description: input.description,
      layer: input.layer,
      labelledBy: actor.username,
      labelledAt: nowIso(),
      ...(input.type ? { type: input.type } : {}),
    };
    return this.outbox.transaction(actor.tenantId, async ({ tx, emit }) => {
      const ci = await this.repo.label(
        tx,
        actor.tenantId,
        input.ciId,
        label,
        input.layer,
        input.type ?? null,
      );
      await emit({
        type: 'openmap.ci.labelled',
        subject: ci.id,
        data: { ciId: ci.id, label, layer: ci.layer, type: ci.type, derivedLayer: CI_TYPE_LAYER[ci.type] },
      });
      // REQ-CMDB-040 (ADR-023): an unknown device classified into an owned type joins the asset register at once,
      // with whatever its attributes already say; the person then fills warranty, support and end of life.
      if (isOwnedCiType(ci.type)) {
        const asset = await ensureAssetForCi(tx, actor.tenantId, actor.username, ci, ci.layer, nowIso());
        await emit({ type: 'openmap.asset.created', subject: asset.id, data: { assetId: asset.id, ciId: ci.id, source: asset.source, layer: asset.layer, dataGaps: asset.dataGaps, by: actor.username } });
      }
      return ci;
    });
  }

  async updateAttributes(actor: Actor, ciId: string, attributes: Record<string, unknown>): Promise<CiRecord> {
    return this.outbox.transaction(actor.tenantId, async ({ tx, emit }) => {
      const current = await this.repo.findById(actor.tenantId, ciId, null);
      if (!current) throw new NotFoundException('CI ' + ciId + ' not found');
      const merged = { ...current.attributes, ...attributes };
      const ci = await this.repo.updateAttributes(
        tx,
        actor.tenantId,
        ciId,
        merged,
        checksumOf(current.type, current.identity, merged),
      );
      await emit({
        type: 'openmap.ci.updated',
        subject: ci.id,
        data: {
          ciId: ci.id,
          changed: Object.keys(attributes),
          attributes: ci.attributes,
          checksum: ci.checksum,
          by: actor.username,
        },
      });
      return ci;
    });
  }

  /** REQ-CMDB-037 — rename a short code; Postgres keeps the per-tenant invariant, this gives the operator a clear refusal. */
  async setCode(actor: Actor, ciId: string, code: string): Promise<CiRecord> {
    return this.outbox.transaction(actor.tenantId, async ({ tx, emit }) => {
      const current = await this.repo.findById(actor.tenantId, ciId, null);
      if (!current) throw new NotFoundException('CI ' + ciId + ' not found');
      const holder = await this.repo.findCurrentByCode(actor.tenantId, code);
      if (holder !== null && holder.id !== ciId)
        throw new ConflictException('code ' + code + ' already names ' + holder.displayName);
      const ci = await this.repo.updateCode(tx, actor.tenantId, ciId, code);
      await emit({
        type: 'openmap.ci.updated',
        subject: ci.id,
        data: {
          ciId: ci.id,
          changed: ['code'],
          code: ci.code,
          previousCode: current.code,
          by: actor.username,
        },
      });
      return ci;
    });
  }

  /**
   * REQ-CMDB-013 — a lifecycle set by hand. The event carries the CI so the graph and the search index take the new
   * lifecycle; the reconciler keeps it on later sweeps (an update spreads the stored CI).
   */
  async setLifecycle(actor: Actor, ciId: string, lifecycle: Lifecycle): Promise<CiRecord> {
    return this.outbox.transaction(actor.tenantId, async ({ tx, emit }) => {
      const current = await this.repo.findById(actor.tenantId, ciId, null);
      if (!current) throw new NotFoundException('CI ' + ciId + ' not found');
      const ci = await this.repo.updateLifecycle(tx, actor.tenantId, ciId, lifecycle);
      await emit({
        type: 'openmap.ci.updated',
        subject: ci.id,
        data: { ci, ciId: ci.id, changed: ['lifecycle'], lifecycle, previousLifecycle: current.lifecycle, by: actor.username },
      });
      return ci;
    });
  }

  /** REQ-CMDB-016 — the CI's tags replaced; a tag a collector observes again is merged back on its next sweep. */
  async setTags(actor: Actor, ciId: string, tags: readonly string[]): Promise<CiRecord> {
    return this.outbox.transaction(actor.tenantId, async ({ tx, emit }) => {
      const current = await this.repo.findById(actor.tenantId, ciId, null);
      if (!current) throw new NotFoundException('CI ' + ciId + ' not found');
      const ci = await this.repo.updateTags(tx, actor.tenantId, ciId, tags);
      const added = tags.filter((tag) => !current.tags.includes(tag));
      const removed = current.tags.filter((tag) => !tags.includes(tag));
      await emit({
        type: 'openmap.ci.updated',
        subject: ci.id,
        data: { ci, ciId: ci.id, changed: ['tags'], added, removed, by: actor.username },
      });
      return ci;
    });
  }

  tagCounts(tenantId: string, limit: number): Promise<Array<{ tag: string; count: number }>> {
    return this.repo.tagCounts(tenantId, limit);
  }

  async createRelationship(
    actor: Actor,
    type: RelationshipType,
    fromCiId: string,
    toCiId: string,
    attributes: Record<string, unknown>,
  ): Promise<RelationshipRecord> {
    return this.outbox.transaction(actor.tenantId, async ({ tx, emit }) => {
      const rel = await this.repo.createRelationship(tx, actor.tenantId, {
        type,
        fromCiId,
        toCiId,
        attributes,
        runId: actor.requestId,
        confidence: RECONCILIATION.userLabelConfidence,
      });
      await emit({
        type: 'openmap.relationship.created',
        subject: rel.id,
        data: { relationship: rel, by: actor.username },
      });
      return rel;
    });
  }

  async retireRelationship(actor: Actor, id: string): Promise<RelationshipRecord> {
    return this.outbox.transaction(actor.tenantId, async ({ tx, emit }) => {
      const rel = await this.repo.retireRelationship(tx, actor.tenantId, id, nowIso());
      await emit({
        type: 'openmap.relationship.retired',
        subject: rel.id,
        data: { relationshipId: rel.id, validTo: rel.validTo, by: actor.username },
      });
      return rel;
    });
  }

  private async idsWithHealth(tenantId: string, states: readonly HealthState[]): Promise<string[]> {
    const rows = await this.graph.repo.readOnly<{ id: string }>(HEALTH_IDS_QUERY, {
      tenantId,
      states: [...states],
    });
    return rows.map((r) => r.id);
  }
}

function toVulnerability(affected: CiRecord, vuln: CiRecord): VulnerabilityRecord {
  const a = vuln.attributes;
  return {
    ci: affected,
    cveId: stringAttribute(a, 'cveId') ?? vuln.name,
    // Feeds and the synthetic estate write cvssScore / exploitedInWild; older collectors cvss / exploited.
    cvss: numberAttribute(a, 'cvssScore') ?? numberAttribute(a, 'cvss') ?? 0,
    severity: stringAttribute(a, 'severity') ?? 'unknown',
    fixedIn: stringAttribute(a, 'fixedIn'),
    exploited: booleanAttribute(a, 'exploitedInWild') ?? booleanAttribute(a, 'exploited') ?? false,
    internetFacing: booleanAttribute(a, 'internetFacing') ?? false,
  };
}
