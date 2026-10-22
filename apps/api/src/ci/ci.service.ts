// REQ-CMDB-001 — CMDB use cases: paginated and time-travel reads, search, user labelling, attribute
// edits and relationship writes. Every write goes through the outbox in one Postgres transaction.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { RECONCILIATION } from '@openmap/constants';
import { CI_TYPE_LAYER, type CiLayer, type RelationshipType, type UserLabel } from '@openmap/contracts';
import { clampPageSize, decodeCursor, encodeCursor } from '../common/cursor.js';
import { nowIso } from '../common/time.js';
import { booleanAttribute, numberAttribute, stringAttribute } from '../common/validation.js';
import { GraphService } from '../db/graph.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { checksumOf } from './checksum.js';
import type { CiLoaders } from './ci.loaders.js';
import { toVersion } from './ci.mapper.js';
import { CI_REPOSITORY, type CiRepository } from './ci.repository.js';
import type { CiFilterInput, LabelCiInput } from './ci.schemas.js';
import type { CiRecord, CiVersionRecord, Connection, HealthState, RelationshipDirection, RelationshipRecord, SearchHitRecord, VulnerabilityRecord } from './ci.types.js';

/** Relationship type from an affected CI to the vulnerability CI describing the weakness. */
export const AFFECTED_BY: RelationshipType = 'affected_by';

const HEALTH_IDS_QUERY = 'MATCH (c:Ci {tenantId: $tenantId}) WHERE c.health IN $states AND c.validTo IS NULL RETURN c.id AS id';

export interface Actor {
  tenantId: string;
  username: string;
  requestId: string;
}

@Injectable()
export class CiService {
  constructor(
    @Inject(CI_REPOSITORY) private readonly repo: CiRepository,
    private readonly graph: GraphService,
    private readonly outbox: OutboxService,
  ) {}

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

  async cis(tenantId: string, filter: CiFilterInput, first: number | null | undefined, after: string | null | undefined, loaders: CiLoaders | null): Promise<Connection<CiRecord>> {
    const size = clampPageSize(first);
    const cursor = after ? decodeCursor(after) : null;
    const healthIds = filter.health && filter.health.length > 0 ? await this.idsWithHealth(tenantId, filter.health) : null;
    const page = await this.repo.list(tenantId, filter, healthIds, size, cursor);
    if (loaders) for (const ci of page.items) loaders.ci.prime(ci.id, ci);
    const edges = page.items.map((node) => ({ cursor: encodeCursor({ name: node.name, id: node.id }), node }));
    const last = edges[edges.length - 1];
    return { edges, pageInfo: { endCursor: last ? last.cursor : null, hasNextPage: page.hasNextPage }, totalCount: page.totalCount };
  }

  unknownCis(tenantId: string, first: number | null | undefined, after: string | null | undefined, loaders: CiLoaders | null): Promise<Connection<CiRecord>> {
    return this.cis(tenantId, { types: ['unknown'] }, first, after, loaders);
  }

  async search(tenantId: string, text: string, layers: readonly CiLayer[], first: number | null | undefined): Promise<SearchHitRecord[]> {
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

  async relationships(tenantId: string, ciId: string, direction: RelationshipDirection, types: readonly RelationshipType[], first: number | null | undefined, after: string | null | undefined, asOf: string | null): Promise<Connection<RelationshipRecord>> {
    const size = clampPageSize(first);
    const afterId = after ? decodeCursor(after).id : null;
    const page = await this.repo.relationships(tenantId, { ciId, direction, types, first: size, afterId, asOf });
    const edges = page.items.map((node) => ({ cursor: encodeCursor({ name: node.type, id: node.id }), node }));
    const last = edges[edges.length - 1];
    return { edges, pageInfo: { endCursor: last ? last.cursor : null, hasNextPage: page.hasNextPage }, totalCount: page.totalCount };
  }

  async history(tenantId: string, ciId: string, from: string | null, to: string | null): Promise<CiVersionRecord[]> {
    return (await this.repo.versions(tenantId, ciId, from, to)).map(toVersion);
  }

  async vulnerabilitiesOf(tenantId: string, ci: CiRecord): Promise<VulnerabilityRecord[]> {
    const rels = await this.repo.relationshipsOfMany(tenantId, [ci.id], [AFFECTED_BY], 'downstream');
    const vulns = await this.repo.findByIds(tenantId, rels.map((r) => r.toCiId));
    return vulns.filter((v) => v.type === 'vulnerability').map((v) => toVulnerability(ci, v));
  }

  async vulnerabilities(tenantId: string, minCvss: number | null, internetFacing: boolean | null): Promise<VulnerabilityRecord[]> {
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
      const ci = await this.repo.label(tx, actor.tenantId, input.ciId, label, input.layer, input.type ?? null);
      await emit({ type: 'openmap.ci.labelled', subject: ci.id, data: { ciId: ci.id, label, layer: ci.layer, type: ci.type, derivedLayer: CI_TYPE_LAYER[ci.type] } });
      return ci;
    });
  }

  async updateAttributes(actor: Actor, ciId: string, attributes: Record<string, unknown>): Promise<CiRecord> {
    return this.outbox.transaction(actor.tenantId, async ({ tx, emit }) => {
      const current = await this.repo.findById(actor.tenantId, ciId, null);
      if (!current) throw new NotFoundException('CI ' + ciId + ' not found');
      const merged = { ...current.attributes, ...attributes };
      const ci = await this.repo.updateAttributes(tx, actor.tenantId, ciId, merged, checksumOf(current.type, current.identity, merged));
      await emit({ type: 'openmap.ci.updated', subject: ci.id, data: { ciId: ci.id, changed: Object.keys(attributes), attributes: ci.attributes, checksum: ci.checksum, by: actor.username } });
      return ci;
    });
  }

  async createRelationship(actor: Actor, type: RelationshipType, fromCiId: string, toCiId: string, attributes: Record<string, unknown>): Promise<RelationshipRecord> {
    return this.outbox.transaction(actor.tenantId, async ({ tx, emit }) => {
      const rel = await this.repo.createRelationship(tx, actor.tenantId, { type, fromCiId, toCiId, attributes, runId: actor.requestId, confidence: RECONCILIATION.userLabelConfidence });
      await emit({ type: 'openmap.relationship.created', subject: rel.id, data: { relationship: rel, by: actor.username } });
      return rel;
    });
  }

  async retireRelationship(actor: Actor, id: string): Promise<RelationshipRecord> {
    return this.outbox.transaction(actor.tenantId, async ({ tx, emit }) => {
      const rel = await this.repo.retireRelationship(tx, actor.tenantId, id, nowIso());
      await emit({ type: 'openmap.relationship.retired', subject: rel.id, data: { relationshipId: rel.id, validTo: rel.validTo, by: actor.username } });
      return rel;
    });
  }

  private async idsWithHealth(tenantId: string, states: readonly HealthState[]): Promise<string[]> {
    const rows = await this.graph.repo.readOnly<{ id: string }>(HEALTH_IDS_QUERY, { tenantId, states: [...states] });
    return rows.map((r) => r.id);
  }
}

function toVulnerability(affected: CiRecord, vuln: CiRecord): VulnerabilityRecord {
  const a = vuln.attributes;
  return {
    ci: affected,
    cveId: stringAttribute(a, 'cveId') ?? vuln.name,
    cvss: numberAttribute(a, 'cvss') ?? 0,
    severity: stringAttribute(a, 'severity') ?? 'unknown',
    fixedIn: stringAttribute(a, 'fixedIn'),
    exploited: booleanAttribute(a, 'exploited') ?? false,
    internetFacing: booleanAttribute(a, 'internetFacing') ?? false,
  };
}
