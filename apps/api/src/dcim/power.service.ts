// REQ-DCIM-004 (ADR-058) — a room's power chain: the PDUs of its racks, the circuits feeding them, the UPS units
// feeding those, every device cord on the PDUs (feed, PSU, outlet on the `powered_by` relationship) and the redundancy
// assessment of the contract (single-corded devices, one-feed devices, pairs whose survivor would overload, short UPS
// runtime, PDUs over their outlets). Operators record a cord on an outlet and remove one, through the outbox.
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { BSM, POWER, RECONCILIATION } from '@openmap/constants';
import { POWER_ATTRIBUTES as P, assessPower, circuitRatedWatts, type PowerConnectionInput, type PowerCord, type PowerFinding, type PowerSourceNode } from '@openmap/contracts';
import { withSpan } from '@openmap/telemetry';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord, RelationshipRecord } from '../ci/ci.types.js';
import { nowIso } from '../common/time.js';
import { numberAttribute, stringAttribute } from '../common/validation.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { DcimService, POWERED_BY } from './dcim.service.js';

/** CI types a device cord can never come from: the power chain itself. */
const SOURCE_TYPES: ReadonlySet<string> = new Set(['ups', 'power_circuit', 'pdu', 'power_feed']);

export interface PowerSourceView {
  ci: CiRecord;
  kind: PowerSourceNode['kind'];
  feed: string | null;
  ratedWatts: number | null;
  loadWatts: number | null;
  outlets: number | null;
  outletsUsed: number;
  runtimeMinutes: number | null;
  fedByIds: string[];
  rackId: string | null;
}

export interface PowerConnectionView {
  id: string;
  deviceId: string;
  pduId: string;
  feed: string | null;
  psu: number | null;
  outlet: number | null;
}

export interface PowerChainView {
  summary: { ups: number; circuits: number; pdus: number; devices: number; redundantDevices: number; findings: number };
  sources: PowerSourceView[];
  findings: PowerFinding[];
}

function cordOf(rel: RelationshipRecord, pdu: CiRecord | undefined): PowerConnectionView {
  return {
    id: rel.id,
    deviceId: rel.fromCiId,
    pduId: rel.toCiId,
    feed: stringAttribute(rel.attributes, P.feed) ?? (pdu === undefined ? null : stringAttribute(pdu.attributes, P.feed)),
    psu: numberAttribute(rel.attributes, P.psu),
    outlet: numberAttribute(rel.attributes, P.outlet),
  };
}

@Injectable()
export class PowerService {
  constructor(
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly dcim: DcimService,
    private readonly outbox: OutboxService,
    private readonly metrics: MetricsService,
  ) {}

  async chain(tenantId: string, roomId: string): Promise<PowerChainView> {
    return withSpan(TRACER_NAME, 'dcim.power.chain', { 'openmap.tenant': tenantId }, async () => {
      const racks = await this.dcim.racks(tenantId, roomId);
      const pdus = racks.flatMap((r) => r.powerFeeds.filter((f) => f.ci.type === 'pdu').map((f) => ({ feed: f, rackId: r.ci.id })));
      const pduIds = pdus.map((p) => p.feed.ci.id);
      const [pduUp, cordRels] = await Promise.all([
        this.cis.relationshipsOfMany(tenantId, pduIds, [POWERED_BY], 'downstream'),
        this.cis.relationshipsOfMany(tenantId, pduIds, [POWERED_BY], 'upstream'),
      ]);
      const circuits = (await this.cis.findByIds(tenantId, [...new Set(pduUp.map((r) => r.toCiId))])).filter((c) => c.type === 'power_circuit' && c.validTo === null);
      const circuitUp = await this.cis.relationshipsOfMany(tenantId, circuits.map((c) => c.id), [POWERED_BY], 'downstream');
      const upsUnits = (await this.cis.findByIds(tenantId, [...new Set(circuitUp.map((r) => r.toCiId))])).filter((c) => c.type === 'ups' && c.validTo === null);
      const pduById = new Map(pdus.map((p) => [p.feed.ci.id, p.feed.ci]));
      const cords = cordRels.map((rel) => cordOf(rel, pduById.get(rel.toCiId)));

      const pduLoad = new Map(pdus.map((p) => [p.feed.ci.id, p.feed.currentWatts]));
      const sources: PowerSourceView[] = [
        ...upsUnits.map((u) => {
          const ratedKw = numberAttribute(u.attributes, P.ratedKw);
          const loadPercent = numberAttribute(u.attributes, P.loadPercent);
          return {
            ci: u,
            kind: 'ups' as const,
            feed: stringAttribute(u.attributes, P.feed),
            ratedWatts: ratedKw === null ? null : Math.round(ratedKw * POWER.wattsPerKilowatt),
            loadWatts: ratedKw === null || loadPercent === null ? null : Math.round((ratedKw * POWER.wattsPerKilowatt * loadPercent) / BSM.percentScale),
            outlets: null,
            outletsUsed: 0,
            runtimeMinutes: numberAttribute(u.attributes, P.runtimeMinutes),
            fedByIds: [],
            rackId: null,
          };
        }),
        ...circuits.map((c) => {
          const amps = numberAttribute(c.attributes, P.ratedAmps);
          const volts = numberAttribute(c.attributes, P.voltage);
          const fed = pduUp.filter((r) => r.toCiId === c.id).map((r) => r.fromCiId);
          return {
            ci: c,
            kind: 'power_circuit' as const,
            feed: stringAttribute(c.attributes, P.feed),
            ratedWatts: amps === null || volts === null ? null : circuitRatedWatts(amps, volts, numberAttribute(c.attributes, P.phases) ?? 1),
            // The load of this room's PDUs on the circuit: what this room would move onto the partner circuit.
            loadWatts: fed.reduce((sum, id) => sum + (pduLoad.get(id) ?? 0), 0),
            outlets: null,
            outletsUsed: 0,
            runtimeMinutes: null,
            fedByIds: circuitUp.filter((r) => r.fromCiId === c.id).map((r) => r.toCiId),
            rackId: null,
          };
        }),
        ...pdus.map(({ feed, rackId }) => ({
          ci: feed.ci,
          kind: 'pdu' as const,
          feed: stringAttribute(feed.ci.attributes, P.feed),
          ratedWatts: feed.ratedWatts > 0 ? feed.ratedWatts : null,
          loadWatts: feed.currentWatts,
          outlets: numberAttribute(feed.ci.attributes, P.outlets),
          outletsUsed: cords.filter((c) => c.pduId === feed.ci.id).length,
          runtimeMinutes: null,
          fedByIds: pduUp.filter((r) => r.fromCiId === feed.ci.id).map((r) => r.toCiId),
          rackId,
        })),
      ];
      const nodes: PowerSourceNode[] = sources.map((s) => ({
        id: s.ci.id,
        kind: s.kind,
        feed: s.feed,
        ratedWatts: s.ratedWatts,
        loadWatts: s.loadWatts,
        group: s.kind === 'pdu' ? s.rackId : roomId,
        outlets: s.outlets,
        runtimeMinutes: s.runtimeMinutes,
      }));
      const powerCords: PowerCord[] = cords.map((c) => ({ deviceId: c.deviceId, pduId: c.pduId, feed: c.feed }));
      const findings = assessPower(nodes, powerCords);
      const devices = new Set(cords.map((c) => c.deviceId));
      const exposed = new Set(findings.filter((f) => f.kind === 'single_corded' || f.kind === 'same_feed').map((f) => f.ciId));
      return {
        summary: { ups: upsUnits.length, circuits: circuits.length, pdus: pdus.length, devices: devices.size, redundantDevices: devices.size - exposed.size, findings: findings.length },
        sources,
        findings,
      };
    });
  }

  async connections(tenantId: string, pduId: string): Promise<PowerConnectionView[]> {
    const pdu = await this.requirePdu(tenantId, pduId);
    const rels = await this.cis.relationshipsOfMany(tenantId, [pduId], [POWERED_BY], 'upstream');
    return rels.map((r) => cordOf(r, pdu)).sort((a, b) => (a.outlet ?? Number.MAX_SAFE_INTEGER) - (b.outlet ?? Number.MAX_SAFE_INTEGER));
  }

  private async requirePdu(tenantId: string, id: string): Promise<CiRecord> {
    const pdu = await this.cis.findById(tenantId, id, null);
    if (!pdu || pdu.type !== 'pdu' || pdu.validTo !== null) throw new NotFoundException('pdu ' + id + ' not found');
    return pdu;
  }

  /** A device cord on a PDU outlet: the outlet within the PDU's count and free; the cord takes the PDU's feed. */
  async connect(tenantId: string, actor: string, input: PowerConnectionInput): Promise<PowerConnectionView> {
    const pdu = await this.requirePdu(tenantId, input.pduId);
    const device = await this.cis.findById(tenantId, input.deviceId, null);
    if (!device || device.validTo !== null) throw new NotFoundException('CI ' + input.deviceId + ' not found');
    if (SOURCE_TYPES.has(device.type)) throw new BadRequestException('a ' + device.type + ' is part of the power chain, not a device on a PDU');
    const existing = await this.connections(tenantId, pdu.id);
    const outlets = numberAttribute(pdu.attributes, P.outlets);
    if (input.outlet !== null) {
      if (outlets !== null && input.outlet > outlets) throw new BadRequestException(pdu.name + ' has ' + String(outlets) + ' outlets');
      const taken = existing.find((c) => c.outlet === input.outlet);
      if (taken !== undefined) {
        const [holder] = await this.cis.findByIds(tenantId, [taken.deviceId]);
        throw new ConflictException(pdu.name + ' outlet ' + String(input.outlet) + ' feeds ' + (holder?.name ?? taken.deviceId));
      }
    }
    const feed = stringAttribute(pdu.attributes, P.feed);
    const relId = await withSpan(TRACER_NAME, 'dcim.power.connect', { 'openmap.tenant': tenantId }, () =>
      this.outbox.transaction(tenantId, async ({ tx, emit }) => {
        const rel = await this.cis.createRelationship(tx, tenantId, {
          type: POWERED_BY,
          fromCiId: device.id,
          toCiId: pdu.id,
          attributes: { [P.feed]: feed, [P.psu]: input.psu, [P.outlet]: input.outlet },
          runId: randomUUID(),
          confidence: RECONCILIATION.userLabelConfidence,
        });
        await emit({ type: 'openmap.relationship.created', subject: rel.id, data: { relationship: rel, by: actor } });
        await emit({ type: 'openmap.audit.action', subject: rel.id, data: { action: 'dcim.power.connected', device: device.name, pdu: pdu.name, outlet: input.outlet, psu: input.psu, by: actor } });
        return rel.id;
      }),
    );
    this.metrics.powerConnections.inc({ op: 'connected' });
    const view = (await this.connections(tenantId, pdu.id)).find((c) => c.id === relId);
    if (!view) throw new NotFoundException('power connection ' + relId + ' not found');
    return view;
  }

  async disconnect(tenantId: string, actor: string, id: string): Promise<boolean> {
    const rel = await this.cis.relationshipById(tenantId, id);
    if (!rel || rel.type !== POWERED_BY || rel.validTo !== null) throw new NotFoundException('power connection ' + id + ' not found');
    await this.requirePdu(tenantId, rel.toCiId);
    await withSpan(TRACER_NAME, 'dcim.power.disconnect', { 'openmap.tenant': tenantId }, () =>
      this.outbox.transaction(tenantId, async ({ tx, emit }) => {
        const retired = await this.cis.retireRelationship(tx, tenantId, id, nowIso());
        await emit({ type: 'openmap.relationship.retired', subject: retired.id, data: { relationshipId: retired.id, validTo: retired.validTo, by: actor } });
        await emit({ type: 'openmap.audit.action', subject: id, data: { action: 'dcim.power.disconnected', by: actor } });
      }),
    );
    this.metrics.powerConnections.inc({ op: 'disconnected' });
    return true;
  }
}
