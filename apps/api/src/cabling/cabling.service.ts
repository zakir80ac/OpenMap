// REQ-DCIM-001 (ADR-056) — structured cabling over CIs. A patch panel is a `patch_panel` CI `located_in` its rack
// (with its rack unit); a cable is a `cable` CI and a carrier circuit a `circuit` CI, each `connected_to` its ends with
// the end (A, B or Z), the port and, on a panel, the side on the relationship. People mount panels, connect and
// disconnect cables and record circuits through the outbox, so the graph, search and history follow; a port (a panel
// position's side, or a device port) takes one cable or circuit. The trace walks cable → panel → cable to the far end.
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { RECONCILIATION } from '@openmap/constants';
import {
  CABLE_KINDS,
  CABLE_MEDIA,
  CABLING_ATTRIBUTES as A,
  CIRCUIT_KINDS,
  CIRCUIT_STATUSES,
  DCIM_ATTRIBUTES,
  LINK_ENDS,
  PANEL_CONNECTORS,
  PANEL_SIDES,
  endpointKey,
  endpointProblem,
  traceCable,
  type CableEndpoint,
  type CableInput,
  type CableLink,
  type CircuitInput,
  type CiType,
  type LinkEnd,
  type PatchPanelInput,
} from '@openmap/contracts';
import type { Prisma } from '@openmap/db';
import { withSpan } from '@openmap/telemetry';
import { z } from 'zod';
import { checksumOf } from '../ci/checksum.js';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord, RelationshipRecord } from '../ci/ci.types.js';
import { nowIso } from '../common/time.js';
import { numberAttribute, stringAttribute } from '../common/validation.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { OutboxService, type OutboxDraft } from '../outbox/outbox.service.js';
import type { CableTraceView, CableView, CablingView, CircuitView, EndpointView, PatchPanelView } from './cabling.types.js';

type Emit = (draft: OutboxDraft) => Promise<unknown>;
type Tx = Prisma.TransactionClient;

const CONNECTED_TO = 'connected_to';
const LOCATED_IN = 'located_in';
const LINK_TYPES: ReadonlySet<CiType> = new Set<CiType>(['cable', 'circuit']);
const PANEL_HEIGHT_U = 1;

const kindOf = z.enum(CABLE_KINDS);
const mediaOf = z.enum(CABLE_MEDIA);
const connectorOf = z.enum(PANEL_CONNECTORS);
const sideOf = z.enum(PANEL_SIDES);
const endOf = z.enum(LINK_ENDS);
const circuitKindOf = z.enum(CIRCUIT_KINDS);
const circuitStatusOf = z.enum(CIRCUIT_STATUSES);

function parsed<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const r = schema.safeParse(value);
  return r.success ? r.data : null;
}

/** The end a `connected_to` relationship from a cable or circuit names, with its port and panel side. */
function endOfRel(rel: RelationshipRecord): { end: LinkEnd; endpoint: EndpointView } | null {
  const end = parsed(endOf, rel.attributes[A.end]);
  if (end === null) return null;
  return { end, endpoint: { ciId: rel.toCiId, port: stringAttribute(rel.attributes, A.port), side: parsed(sideOf, rel.attributes[A.side]) } };
}

function endAttributes(end: LinkEnd, e: CableEndpoint): Record<string, unknown> {
  return { [A.end]: end, [A.port]: e.port, [A.side]: e.side };
}

interface Loaded {
  panels: CiRecord[];
  cables: CableView[];
  circuits: CircuitView[];
  links: CableLink[];
}

@Injectable()
export class CablingService {
  constructor(
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly outbox: OutboxService,
    private readonly metrics: MetricsService,
  ) {}

  private async load(tenantId: string): Promise<Loaded> {
    const [panels, cableCis, circuitCis] = await Promise.all([this.cis.byType(tenantId, 'patch_panel'), this.cis.byType(tenantId, 'cable'), this.cis.byType(tenantId, 'circuit')]);
    const ends = await this.cis.relationshipsOfMany(tenantId, [...cableCis, ...circuitCis].map((c) => c.id), [CONNECTED_TO], 'downstream');
    const endsOf = new Map<string, Map<LinkEnd, EndpointView>>();
    for (const rel of ends) {
      const e = endOfRel(rel);
      if (e === null) continue;
      const m = endsOf.get(rel.fromCiId) ?? new Map<LinkEnd, EndpointView>();
      m.set(e.end, e.endpoint);
      endsOf.set(rel.fromCiId, m);
    }
    const cables: CableView[] = [];
    for (const ci of cableCis) {
      const a = endsOf.get(ci.id)?.get('A');
      const b = endsOf.get(ci.id)?.get('B');
      // A cable CI without both ends (an import of a cable list) is not part of any path yet.
      if (a === undefined || b === undefined) continue;
      cables.push({
        ci,
        label: stringAttribute(ci.identity, 'label') ?? ci.name,
        kind: parsed(kindOf, ci.attributes[A.kind]),
        media: parsed(mediaOf, ci.attributes[A.media]),
        lengthM: numberAttribute(ci.attributes, A.lengthM),
        colour: stringAttribute(ci.attributes, A.colour),
        a,
        b,
      });
    }
    const circuits: CircuitView[] = circuitCis.map((ci) => ({
      ci,
      provider: stringAttribute(ci.identity, A.provider) ?? '',
      circuitId: stringAttribute(ci.identity, A.circuitId) ?? ci.name,
      kind: parsed(circuitKindOf, ci.attributes[A.kind]),
      status: parsed(circuitStatusOf, ci.attributes[A.status]),
      bandwidthMbps: numberAttribute(ci.attributes, A.bandwidthMbps),
      aEnd: endsOf.get(ci.id)?.get('A') ?? null,
      zEnd: endsOf.get(ci.id)?.get('Z') ?? null,
      zEndDescription: stringAttribute(ci.attributes, A.zEndDescription),
    }));
    const links: CableLink[] = [
      ...cables.map((c) => ({ id: c.ci.id, via: 'cable' as const, a: c.a, b: c.b })),
      ...circuits.flatMap((c) => (c.aEnd !== null && c.zEnd !== null ? [{ id: c.ci.id, via: 'circuit' as const, a: c.aEnd, b: c.zEnd }] : [])),
    ];
    return { panels, cables, circuits, links };
  }

  async cabling(tenantId: string): Promise<CablingView> {
    return withSpan(TRACER_NAME, 'cabling.read', { 'openmap.tenant': tenantId }, async () => {
      const loaded = await this.load(tenantId);
      const racks = await this.cis.relationshipsOfMany(tenantId, loaded.panels.map((p) => p.id), [LOCATED_IN], 'downstream');
      const patchPanels = loaded.panels.map((p) => this.panelView(p, racks.find((r) => r.fromCiId === p.id) ?? null, loaded.cables, loaded.circuits)).sort((x, y) => x.ci.name.localeCompare(y.ci.name));
      const cables = [...loaded.cables].sort((x, y) => x.label.localeCompare(y.label));
      const circuits = [...loaded.circuits].sort((x, y) => x.provider.localeCompare(y.provider) || x.circuitId.localeCompare(y.circuitId));
      return {
        summary: {
          patchPanels: patchPanels.length,
          positions: patchPanels.reduce((n, p) => n + p.ports, 0),
          positionsUsed: patchPanels.reduce((n, p) => n + p.used, 0),
          cables: cables.length,
          crossConnects: cables.filter((c) => c.kind === 'cross_connect').length,
          circuits: circuits.length,
        },
        patchPanels,
        cables,
        circuits,
      };
    });
  }

  private panelView(panel: CiRecord, rackRel: RelationshipRecord | null, cables: readonly CableView[], circuits: readonly CircuitView[]): PatchPanelView {
    const ports = numberAttribute(panel.attributes, A.ports) ?? 0;
    const here = (e: EndpointView | null, position: number): boolean => e !== null && e.ciId === panel.id && e.port === String(position);
    const on = (position: number, side: 'front' | 'rear'): CableView | null => cables.find((c) => [c.a, c.b].some((e) => here(e, position) && e.side === side)) ?? null;
    const circuitAt = (position: number): CircuitView | null => circuits.find((c) => here(c.aEnd, position) || here(c.zEnd, position)) ?? null;
    const positions = Array.from({ length: ports }, (_, i) => ({ position: i + 1, front: on(i + 1, 'front'), rear: on(i + 1, 'rear'), circuit: circuitAt(i + 1) }));
    return {
      ci: panel,
      rackCiId: rackRel?.toCiId ?? null,
      name: stringAttribute(panel.identity, 'name') ?? panel.name,
      ports,
      media: parsed(mediaOf, panel.attributes[A.media]),
      connector: parsed(connectorOf, panel.attributes[A.connector]),
      uPosition: rackRel === null ? null : (DCIM_ATTRIBUTES.position.map((k) => numberAttribute(rackRel.attributes, k)).find((v) => v !== null) ?? null),
      used: positions.filter((p) => p.front !== null || p.rear !== null || p.circuit !== null).length,
      positions,
    };
  }

  async trace(tenantId: string, start: CableEndpoint): Promise<CableTraceView> {
    return withSpan(TRACER_NAME, 'cabling.trace', { 'openmap.tenant': tenantId }, async () => {
      const loaded = await this.load(tenantId);
      const panels = new Set(loaded.panels.map((p) => p.id));
      const t = traceCable(start, loaded.links, (id) => panels.has(id));
      return { hops: t.hops.map((h) => ({ from: h.from, viaCiId: h.link.id, viaKind: h.link.via, to: h.to })), complete: t.complete, looped: t.looped };
    });
  }

  private async requireCi(tenantId: string, id: string, types: readonly CiType[] | null): Promise<CiRecord> {
    const ci = await this.cis.findById(tenantId, id, null);
    if (!ci || ci.validTo !== null || (types !== null && !types.includes(ci.type))) throw new NotFoundException((types?.join(' or ') ?? 'CI') + ' ' + id + ' not found');
    return ci;
  }

  /**
   * Checks an end: its CI exists and is not itself a cable or circuit, a panel position is within the panel and has a
   * side, and nothing else (other than `except`, the link being changed) is already on that port.
   */
  private async checkEndpoint(tenantId: string, e: CableEndpoint, except: string | null): Promise<CiRecord> {
    const ci = await this.requireCi(tenantId, e.ciId, null);
    if (LINK_TYPES.has(ci.type)) throw new BadRequestException('a cable ends on a port, not on another ' + ci.type);
    const problem = endpointProblem(e, ci.type === 'patch_panel' ? (numberAttribute(ci.attributes, A.ports) ?? 0) : null);
    if (problem !== null) throw new BadRequestException(ci.name + ': ' + problem);
    const onIt = await this.cis.relationshipsOfMany(tenantId, [ci.id], [CONNECTED_TO], 'upstream');
    const taken = onIt.find((rel) => rel.fromCiId !== except && endOfRel(rel) !== null && endpointKey({ ciId: rel.toCiId, port: stringAttribute(rel.attributes, A.port), side: parsed(sideOf, rel.attributes[A.side]) }) === endpointKey(e));
    if (taken !== undefined) {
      const [holder] = await this.cis.findByIds(tenantId, [taken.fromCiId]);
      throw new ConflictException(ci.name + (e.port === null ? '' : ' ' + e.port) + (e.side === null ? '' : ' ' + e.side) + ' already has ' + (holder?.name ?? taken.fromCiId));
    }
    return ci;
  }

  private async createCi(tx: Tx, emit: Emit, tenantId: string, actor: string, draft: { type: CiType; identity: Record<string, string>; name: string; attributes: Record<string, unknown> }): Promise<CiRecord> {
    const taken = await this.cis.findCurrentByIdentity(tenantId, draft.type, draft.identity);
    if (taken) throw new ConflictException(draft.type + ' ' + Object.values(draft.identity).join(' / ') + ' already exists');
    const ci = await this.cis.create(tx, tenantId, {
      type: draft.type,
      identity: draft.identity,
      name: draft.name,
      attributes: { ...draft.attributes, entryMethod: 'manual', enteredBy: actor },
      tags: [],
      lifecycle: 'managed',
      runId: randomUUID(),
      confidence: RECONCILIATION.userLabelConfidence,
    });
    await emit({ type: 'openmap.ci.created', subject: ci.id, data: { ci } });
    return ci;
  }

  private async updateCi(tx: Tx, emit: Emit, tenantId: string, actor: string, current: CiRecord, attributes: Record<string, unknown>): Promise<CiRecord> {
    const merged = { ...current.attributes, ...attributes };
    const ci = await this.cis.updateAttributes(tx, tenantId, current.id, merged, checksumOf(current.type, current.identity, merged));
    await emit({ type: 'openmap.ci.updated', subject: ci.id, data: { ci, ciId: ci.id, changed: Object.keys(attributes), attributes: ci.attributes, checksum: ci.checksum, by: actor } });
    return ci;
  }

  private async link(tx: Tx, emit: Emit, tenantId: string, actor: string, type: 'connected_to' | 'located_in', fromCiId: string, toCiId: string, attributes: Record<string, unknown>): Promise<void> {
    const rel = await this.cis.createRelationship(tx, tenantId, { type, fromCiId, toCiId, attributes, runId: randomUUID(), confidence: RECONCILIATION.userLabelConfidence });
    await emit({ type: 'openmap.relationship.created', subject: rel.id, data: { relationship: rel, by: actor } });
  }

  private async unlink(tx: Tx, emit: Emit, tenantId: string, actor: string, rels: readonly RelationshipRecord[]): Promise<void> {
    const at = nowIso();
    for (const rel of rels) {
      const retired = await this.cis.retireRelationship(tx, tenantId, rel.id, at);
      await emit({ type: 'openmap.relationship.retired', subject: retired.id, data: { relationshipId: retired.id, validTo: retired.validTo, by: actor } });
    }
  }

  private audit(emit: Emit, subject: string, action: string, actor: string, detail: Record<string, unknown>): Promise<unknown> {
    return emit({ type: 'openmap.audit.action', subject, data: { action, ...detail, by: actor } });
  }

  async upsertPatchPanel(tenantId: string, actor: string, id: string | null, input: PatchPanelInput): Promise<PatchPanelView> {
    const rack = await this.requireCi(tenantId, input.rackId, ['rack']);
    return withSpan(TRACER_NAME, 'cabling.panel.save', { 'openmap.tenant': tenantId }, async () => {
      const attributes = { [A.ports]: input.ports, [A.media]: input.media, [A.connector]: input.connector };
      const placement = { [DCIM_ATTRIBUTES.position[0]]: input.uPosition, [DCIM_ATTRIBUTES.height[0]]: PANEL_HEIGHT_U };
      const panelId = await this.outbox.transaction(tenantId, async ({ tx, emit }) => {
        if (id === null) {
          const ci = await this.createCi(tx, emit, tenantId, actor, { type: 'patch_panel', identity: { rackRef: rack.name, name: input.name }, name: rack.name + ' ' + input.name, attributes });
          await this.link(tx, emit, tenantId, actor, LOCATED_IN, ci.id, rack.id, placement);
          await this.audit(emit, ci.id, 'cabling.panel.saved', actor, { rack: rack.name, name: input.name, ports: input.ports });
          return ci.id;
        }
        const current = await this.requireCi(tenantId, id, ['patch_panel']);
        if (stringAttribute(current.identity, 'name') !== input.name || stringAttribute(current.identity, 'rackRef') !== rack.name)
          throw new BadRequestException('the rack and name identify the patch panel and cannot change');
        const loaded = await this.load(tenantId);
        const ends = [...loaded.cables.flatMap((c) => [c.a, c.b]), ...loaded.circuits.flatMap((c) => [c.aEnd, c.zEnd])];
        const highest = Math.max(0, ...ends.filter((e) => e !== null && e.ciId === id).map((e) => Number(e?.port)));
        if (input.ports < highest) throw new BadRequestException('position ' + String(highest) + ' is in use; the panel cannot have fewer ports');
        await this.updateCi(tx, emit, tenantId, actor, current, attributes);
        const placed = await this.cis.relationshipsOfMany(tenantId, [id], [LOCATED_IN], 'downstream');
        await this.unlink(tx, emit, tenantId, actor, placed);
        await this.link(tx, emit, tenantId, actor, LOCATED_IN, id, rack.id, placement);
        await this.audit(emit, id, 'cabling.panel.saved', actor, { rack: rack.name, name: input.name, ports: input.ports });
        return id;
      });
      this.metrics.cablingChanges.inc({ kind: 'patch_panel', op: 'saved' });
      const view = (await this.cabling(tenantId)).patchPanels.find((p) => p.ci.id === panelId);
      if (!view) throw new NotFoundException('patch panel ' + panelId + ' not found');
      return view;
    });
  }

  async connectCable(tenantId: string, actor: string, input: CableInput): Promise<CableView> {
    return withSpan(TRACER_NAME, 'cabling.cable.connect', { 'openmap.tenant': tenantId, 'cabling.kind': input.kind }, async () => {
      const a = await this.checkEndpoint(tenantId, input.a, null);
      const b = await this.checkEndpoint(tenantId, input.b, null);
      const cableId = await this.outbox.transaction(tenantId, async ({ tx, emit }) => {
        const ci = await this.createCi(tx, emit, tenantId, actor, {
          type: 'cable',
          identity: { label: input.label, endpointA: endpointKey(input.a), endpointB: endpointKey(input.b) },
          name: input.label,
          attributes: { [A.kind]: input.kind, [A.media]: input.media, [A.lengthM]: input.lengthM, [A.colour]: input.colour },
        });
        await this.link(tx, emit, tenantId, actor, CONNECTED_TO, ci.id, a.id, endAttributes('A', input.a));
        await this.link(tx, emit, tenantId, actor, CONNECTED_TO, ci.id, b.id, endAttributes('B', input.b));
        await this.audit(emit, ci.id, 'cabling.cable.connected', actor, { label: input.label, kind: input.kind, a: a.name, b: b.name });
        return ci.id;
      });
      this.metrics.cablingChanges.inc({ kind: 'cable', op: 'connected' });
      const view = (await this.load(tenantId)).cables.find((c) => c.ci.id === cableId);
      if (!view) throw new NotFoundException('cable ' + cableId + ' not found');
      return view;
    });
  }

  async disconnectCable(tenantId: string, actor: string, id: string): Promise<boolean> {
    const cable = await this.requireCi(tenantId, id, ['cable']);
    await withSpan(TRACER_NAME, 'cabling.cable.disconnect', { 'openmap.tenant': tenantId }, () => this.retireCi(tenantId, actor, cable, 'cabling.cable.disconnected'));
    this.metrics.cablingChanges.inc({ kind: 'cable', op: 'disconnected' });
    return true;
  }


  /** Retires a CI with the outbox events of its relationships and an audit action. */
  private async retireCi(tenantId: string, actor: string, ci: CiRecord, action: string): Promise<void> {
    await this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const [down, up] = await Promise.all([this.cis.relationshipsOfMany(tenantId, [ci.id], [CONNECTED_TO, LOCATED_IN], 'downstream'), this.cis.relationshipsOfMany(tenantId, [ci.id], [CONNECTED_TO], 'upstream')]);
      await this.unlink(tx, emit, tenantId, actor, [...down, ...up]);
      const retired = await this.cis.retire(tx, tenantId, ci.id);
      await emit({ type: 'openmap.ci.retired', subject: retired.id, data: { ci: retired, by: actor } });
      await this.audit(emit, ci.id, action, actor, { name: ci.name });
    });
  }

  async removePatchPanel(tenantId: string, actor: string, id: string): Promise<boolean> {
    const panel = await this.requireCi(tenantId, id, ['patch_panel']);
    const onIt = await this.cis.relationshipsOfMany(tenantId, [id], [CONNECTED_TO], 'upstream');
    const linked = onIt.filter((rel) => endOfRel(rel) !== null);
    if (linked.length > 0) throw new ConflictException(panel.name + ' has ' + String(linked.length) + ' cable or circuit ends; disconnect them first');
    await withSpan(TRACER_NAME, 'cabling.panel.remove', { 'openmap.tenant': tenantId }, () => this.retireCi(tenantId, actor, panel, 'cabling.panel.removed'));
    this.metrics.cablingChanges.inc({ kind: 'patch_panel', op: 'removed' });
    return true;
  }

  async removeCircuit(tenantId: string, actor: string, id: string): Promise<boolean> {
    const circuit = await this.requireCi(tenantId, id, ['circuit']);
    await withSpan(TRACER_NAME, 'cabling.circuit.remove', { 'openmap.tenant': tenantId }, () => this.retireCi(tenantId, actor, circuit, 'cabling.circuit.removed'));
    this.metrics.cablingChanges.inc({ kind: 'circuit', op: 'removed' });
    return true;
  }

  async upsertCircuit(tenantId: string, actor: string, id: string | null, input: CircuitInput): Promise<CircuitView> {
    return withSpan(TRACER_NAME, 'cabling.circuit.save', { 'openmap.tenant': tenantId, 'cabling.kind': input.kind }, async () => {
      const aEnd = input.aEnd === null ? null : await this.checkEndpoint(tenantId, input.aEnd, id);
      const zEnd = input.zEnd === null ? null : await this.checkEndpoint(tenantId, input.zEnd, id);
      if (input.aEnd !== null && input.zEnd !== null && endpointKey(input.aEnd) === endpointKey(input.zEnd)) throw new BadRequestException('a circuit joins two different ports');
      const attributes = { [A.kind]: input.kind, [A.status]: input.status, [A.bandwidthMbps]: input.bandwidthMbps, [A.zEndDescription]: input.zEndDescription };
      const circuitId = await this.outbox.transaction(tenantId, async ({ tx, emit }) => {
        let ci: CiRecord;
        if (id === null) {
          ci = await this.createCi(tx, emit, tenantId, actor, { type: 'circuit', identity: { circuitId: input.circuitId, provider: input.provider }, name: input.provider + ' ' + input.circuitId, attributes });
        } else {
          const current = await this.requireCi(tenantId, id, ['circuit']);
          if (stringAttribute(current.identity, A.circuitId) !== input.circuitId || stringAttribute(current.identity, A.provider) !== input.provider)
            throw new BadRequestException('the provider and circuit id identify the circuit and cannot change');
          ci = await this.updateCi(tx, emit, tenantId, actor, current, attributes);
          await this.unlink(tx, emit, tenantId, actor, await this.cis.relationshipsOfMany(tenantId, [id], [CONNECTED_TO], 'downstream'));
        }
        if (aEnd !== null && input.aEnd !== null) await this.link(tx, emit, tenantId, actor, CONNECTED_TO, ci.id, aEnd.id, endAttributes('A', input.aEnd));
        if (zEnd !== null && input.zEnd !== null) await this.link(tx, emit, tenantId, actor, CONNECTED_TO, ci.id, zEnd.id, endAttributes('Z', input.zEnd));
        await this.audit(emit, ci.id, 'cabling.circuit.saved', actor, { provider: input.provider, circuitId: input.circuitId, status: input.status });
        return ci.id;
      });
      this.metrics.cablingChanges.inc({ kind: 'circuit', op: 'saved' });
      const view = (await this.load(tenantId)).circuits.find((c) => c.ci.id === circuitId);
      if (!view) throw new NotFoundException('circuit ' + circuitId + ' not found');
      return view;
    });
  }
}
