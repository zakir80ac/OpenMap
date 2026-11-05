// REQ-DEP-002 (ADR-029) — the dependency-mapping pass: loads a tenant's current flows, address owners, listeners and
// components from Postgres, derives `depends_on` edges (core/adm.ts), hands them to the reconciliation pipeline as a
// collector result from the `adm` source (so Memgraph, ClickHouse and Meilisearch learn them through the outbox like
// any observation), refreshes the evidence on edges derived before, and retires derived edges the flows no longer
// support. One summary event per pass; counters and a duration histogram per tenant.
import { randomUUID } from 'node:crypto';
import { ADM, CONTRACT_VERSIONS, TIME } from '@openmap/constants';
import type { CiType, CollectorResult, ObservedRelationship } from '@openmap/contracts';
import { Prisma, type PrismaClient } from '@openmap/db';
import { deriveDependencies, edgeKey, type AdmInput, type Component, type DerivedDependency, type FlowEdge, type Listener } from '../core/adm.js';
import { envelope } from '../core/events.js';
import { insertOutboxBatch } from './persist.js';
import { processResult } from './pipeline.js';

export interface AdmSummary {
  tenantId: string;
  runId: string;
  flows: number;
  derived: number;
  created: number;
  refreshed: number;
  retired: number;
  unresolved: number;
  durationMs: number;
}

interface FlowRow {
  id: string;
  fromCiId: string;
  fromType: CiType;
  toCiId: string;
  toType: CiType;
  attributes: Record<string, unknown>;
  observedAt: Date;
}

interface IpRow {
  id: string;
  name: string;
}

interface OwnerRow {
  fromCiId: string;
  toCiId: string;
}

interface ListenerRow {
  id: string;
  computeId: string;
  attributes: Record<string, unknown>;
}

interface ComponentRow {
  id: string;
  computeIds: string[];
  attributes: Record<string, unknown>;
}

interface DerivedRow {
  id: string;
  fromCiId: string;
  toCiId: string;
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Current flows, in pages, with their evidence attributes in either dialect: the netflow collector's
 * (`port`, `exporters[]`, `windowSeconds` before `observedAt`) or a source that resolved its endpoints
 * (`dstPort`, `exporter`, `firstSeen`/`lastSeen`).
 */
async function loadFlows(prisma: PrismaClient, tenantId: string): Promise<FlowEdge[]> {
  const out: FlowEdge[] = [];
  let after: string | null = null;
  for (;;) {
    const rows: FlowRow[] = await prisma.$queryRaw<FlowRow[]>(Prisma.sql`
      SELECT r.id, r."fromCiId", f.type AS "fromType", r."toCiId", t.type AS "toType", r.attributes, r."observedAt"
      FROM relationships r
      JOIN cis f ON f.id = r."fromCiId" AND f."validTo" IS NULL
      JOIN cis t ON t.id = r."toCiId" AND t."validTo" IS NULL
      WHERE r."tenantId" = ${tenantId}::uuid AND r.type = 'communicates_with'::"RelationshipType" AND r."validTo" IS NULL
        AND (${after}::uuid IS NULL OR r.id > ${after}::uuid)
      ORDER BY r.id
      LIMIT ${ADM.pageSize}`);
    for (const r of rows) {
      const a = r.attributes;
      const observed = r.observedAt.toISOString();
      const windowSeconds = num(a['windowSeconds']);
      const lastSeen = str(a['lastSeen']) ?? observed;
      const firstSeen = str(a['firstSeen']) ?? new Date(new Date(lastSeen).getTime() - windowSeconds * TIME.msPerSecond).toISOString();
      const exporter = str(a['exporter']);
      out.push({
        fromId: r.fromCiId,
        fromType: r.fromType,
        toId: r.toCiId,
        toType: r.toType,
        protocol: str(a['protocol']) ?? 'tcp',
        port: num(a['port'] ?? a['dstPort']),
        flows: num(a['flows']),
        bytes: num(a['bytes']),
        packets: num(a['packets']),
        exporters: exporter === null ? strings(a['exporters']) : [exporter],
        firstSeen,
        lastSeen,
      });
    }
    const last = rows.at(-1);
    if (rows.length < ADM.pageSize || last === undefined) break;
    after = last.id;
  }
  return out;
}

async function loadInput(prisma: PrismaClient, tenantId: string): Promise<AdmInput> {
  const flows = await loadFlows(prisma, tenantId);
  const ipIds = [...new Set(flows.flatMap((f) => [f.fromType === 'ip_address' ? f.fromId : null, f.toType === 'ip_address' ? f.toId : null]).filter((id): id is string => id !== null))];
  const addresses = new Map<string, string>();
  const owners = new Map<string, string[]>();
  const computeNames = new Map<string, string>();
  for (let i = 0; i < ipIds.length; i += ADM.pageSize) {
    const page = ipIds.slice(i, i + ADM.pageSize);
    const ips = await prisma.$queryRaw<IpRow[]>(Prisma.sql`SELECT id, name FROM cis WHERE "tenantId" = ${tenantId}::uuid AND id IN (${Prisma.join(page.map((id) => Prisma.sql`${id}::uuid`))})`);
    for (const ip of ips) addresses.set(ip.id, ip.name);
    const owned = await prisma.$queryRaw<Array<OwnerRow & { name: string }>>(Prisma.sql`
      SELECT r."fromCiId", r."toCiId", c.name
      FROM relationships r JOIN cis c ON c.id = r."fromCiId" AND c."validTo" IS NULL
      WHERE r."tenantId" = ${tenantId}::uuid AND r.type = 'uses_ip'::"RelationshipType" AND r."validTo" IS NULL
        AND r."toCiId" IN (${Prisma.join(page.map((id) => Prisma.sql`${id}::uuid`))})`);
    for (const o of owned) {
      const list = owners.get(o.toCiId) ?? [];
      if (!list.includes(o.fromCiId)) list.push(o.fromCiId);
      owners.set(o.toCiId, list);
      computeNames.set(o.fromCiId, o.name);
    }
  }
  const listenerRows = await prisma.$queryRaw<ListenerRow[]>(Prisma.sql`
    SELECT l.id, r."toCiId" AS "computeId", l.attributes
    FROM cis l JOIN relationships r ON r."fromCiId" = l.id AND r.type = 'runs_on'::"RelationshipType" AND r."validTo" IS NULL
    WHERE l."tenantId" = ${tenantId}::uuid AND l.type = 'listening_service'::"CiType" AND l."validTo" IS NULL`);
  const listeners: Listener[] = listenerRows.map((l) => ({ id: l.id, computeId: l.computeId, protocol: str(l.attributes['protocol']) ?? 'tcp', port: num(l.attributes['port']), process: str(l.attributes['process']) }));
  const componentRows = await prisma.$queryRaw<ComponentRow[]>(Prisma.sql`
    SELECT c.id, array_agg(r."toCiId") AS "computeIds", c.attributes
    FROM cis c JOIN relationships r ON r."fromCiId" = c.id AND r.type = 'runs_on'::"RelationshipType" AND r."validTo" IS NULL
    WHERE c."tenantId" = ${tenantId}::uuid AND c.type = 'application_component'::"CiType" AND c."validTo" IS NULL
    GROUP BY c.id, c.attributes`);
  const components: Component[] = componentRows.map((c) => ({ id: c.id, computeIds: c.computeIds, protocol: str(c.attributes['protocol']), port: c.attributes['port'] === undefined || c.attributes['port'] === null ? null : num(c.attributes['port']), application: str(c.attributes['application']) }));
  return { flows, addresses, owners, computeNames, listeners, components };
}

function toResult(tenantId: string, runId: string, derived: readonly DerivedDependency[], startedAt: string): CollectorResult {
  const relationships: ObservedRelationship[] = derived.map((d) => ({ type: 'depends_on', from: { id: d.fromId }, to: { id: d.toId }, attributes: d.attributes, observedAt: d.observedAt }));
  return {
    jobId: runId,
    runId,
    tenantId,
    collectorId: ADM.collectorId,
    nodeId: ADM.nodeId,
    status: 'success',
    startedAt,
    finishedAt: new Date().toISOString(),
    cis: [],
    relationships,
    samples: [],
    evidence: [],
    errors: [],
    metrics: { targetsAttempted: 1, targetsReached: 1, cisEmitted: 0, relationshipsEmitted: relationships.length, durationMs: 0 },
    contractVersion: CONTRACT_VERSIONS.collector,
  };
}

/** Derived edges already current for the tenant: the previous pass's output, to refresh or retire. */
async function loadDerived(prisma: PrismaClient, tenantId: string): Promise<DerivedRow[]> {
  return prisma.$queryRaw<DerivedRow[]>(Prisma.sql`SELECT id, "fromCiId", "toCiId" FROM relationships WHERE "tenantId" = ${tenantId}::uuid AND "sourceCollectorId" = ${ADM.collectorId} AND type = 'depends_on'::"RelationshipType" AND "validTo" IS NULL`);
}

/**
 * Runs one dependency-mapping pass for a tenant. New edges go through the pipeline (created, versioned, fanned out);
 * edges derived before get their evidence refreshed in place (the graph keeps the edge, the evidence lives on the
 * Postgres row the API reads); edges the flows no longer support are retired with the same event the API emits.
 */
export async function runAdmPass(prisma: PrismaClient, tenantId: string): Promise<AdmSummary> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const runId = randomUUID();
  const input = await loadInput(prisma, tenantId);
  const derived = deriveDependencies(input);
  const before = await loadDerived(prisma, tenantId);
  const beforeByKey = new Map(before.map((r) => [edgeKey(r.fromCiId, r.toCiId), r]));
  const fresh = derived.filter((d) => !beforeByKey.has(edgeKey(d.fromId, d.toId)));
  let created = 0;
  let unresolved = 0;
  for (let i = 0; i < fresh.length; i += ADM.resultBatch) {
    const summary = await processResult(prisma, toResult(tenantId, runId, fresh.slice(i, i + ADM.resultBatch), startedAt));
    created += summary.relationships;
    unresolved += summary.unresolvedRelationships;
  }
  // Every derived edge, new or known, takes this pass's evidence, run id and confidence in one statement per batch:
  // the pipeline stamps a created relationship with the reconciler's default confidence, so the fresh ones need it too.
  let refreshed = 0;
  for (let i = 0; i < derived.length; i += ADM.resultBatch) {
    const batch = derived.slice(i, i + ADM.resultBatch);
    const touched = await prisma.$executeRaw(Prisma.sql`
      UPDATE relationships r
      SET attributes = v.attributes::jsonb, "observedAt" = v.observed::timestamptz, "sourceRunId" = ${runId}, "sourceConfidence" = v.confidence, "updatedAt" = now()
      FROM unnest(${batch.map((d) => d.fromId)}::uuid[], ${batch.map((d) => d.toId)}::uuid[], ${batch.map((d) => JSON.stringify(d.attributes))}::text[], ${batch.map((d) => d.observedAt)}::text[], ${batch.map((d) => d.confidence)}::float8[]) AS v(from_id, to_id, attributes, observed, confidence)
      WHERE r."tenantId" = ${tenantId}::uuid AND r."sourceCollectorId" = ${ADM.collectorId} AND r.type = 'depends_on'::"RelationshipType" AND r."validTo" IS NULL
        AND r."fromCiId" = v.from_id AND r."toCiId" = v.to_id`);
    refreshed += touched;
  }
  refreshed = Math.max(0, refreshed - created);
  const derivedKeys = new Set(derived.map((d) => edgeKey(d.fromId, d.toId)));
  const stale = before.filter((r) => !derivedKeys.has(edgeKey(r.fromCiId, r.toCiId)));
  const now = new Date();
  if (stale.length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.relationship.updateMany({ where: { id: { in: stale.map((r) => r.id) } }, data: { validTo: now } });
      await insertOutboxBatch(
        tx,
        stale.map((r) => envelope(tenantId, 'openmap.relationship.retired', r.id, { relationshipId: r.id, validTo: now.toISOString(), by: ADM.collectorId })),
      );
    });
  }
  const summary: AdmSummary = { tenantId, runId, flows: input.flows.length, derived: derived.length, created, refreshed, retired: stale.length, unresolved, durationMs: Date.now() - started };
  await prisma.$transaction(async (tx) => {
    await insertOutboxBatch(tx, [envelope(tenantId, 'openmap.dependency.derived', tenantId, { ...summary })]);
  });
  return summary;
}

/** Whether a reconciled result carried anything a pass joins on. */
export function triggersAdm(result: CollectorResult): boolean {
  if (result.collectorId === ADM.collectorId) return false;
  const ciTypes: readonly string[] = ADM.triggerCiTypes;
  const relTypes: readonly string[] = ADM.triggerRelationshipTypes;
  return result.cis.some((c) => ciTypes.includes(c.type)) || result.relationships.some((r) => relTypes.includes(r.type));
}

/** Debounced per-tenant scheduling: a sweep of many results runs the pass once, ADM.debounceMs after the last. */
export class AdmScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly run: (tenantId: string) => Promise<void>,
    private readonly delayMs: number = ADM.debounceMs,
  ) {}

  schedule(tenantId: string): void {
    const pending = this.timers.get(tenantId);
    if (pending !== undefined) clearTimeout(pending);
    this.timers.set(
      tenantId,
      setTimeout(() => {
        this.timers.delete(tenantId);
        const previous = this.inFlight.get(tenantId) ?? Promise.resolve();
        const next = previous.then(() => this.run(tenantId)).catch(() => undefined);
        this.inFlight.set(tenantId, next);
      }, this.delayMs),
    );
  }

  /** Waits for scheduled and running passes; used on shutdown and by the replay tool. */
  async drain(): Promise<void> {
    for (const [tenantId, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(tenantId);
      const previous = this.inFlight.get(tenantId) ?? Promise.resolve();
      this.inFlight.set(tenantId, previous.then(() => this.run(tenantId)).catch(() => undefined));
    }
    await Promise.all([...this.inFlight.values()]);
  }
}
