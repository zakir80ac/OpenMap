// REQ-CORE-005 — outbox dispatcher: delivers every pending event to Memgraph, ClickHouse and
// Meilisearch, and republishes it on the event stream for the BSM engine and the API's WebSocket
// fan-out. Each target is removed from `pending` on success, so a failing store never blocks the others.
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { HTTP, RECONCILER, SLA } from '@openmap/constants';
import type { Env } from '@openmap/config';
import {
  eventEnvelopeSchema,
  metricSampleSchema,
  type Ci,
  type EventEnvelope,
  type Relationship,
  HEALTH_STATES,
} from '@openmap/contracts';
import { z } from 'zod';
import type { PrismaClient } from '@openmap/db';
import type { GraphCi, GraphRelationship, GraphRepository } from '@openmap/graph';

export type OutboxTarget = 'memgraph' | 'clickhouse' | 'meilisearch' | 'websocket' | 'bsm';

export interface Sinks {
  graph: GraphRepository;
  clickhouse: ClickHouseClient;
  search: SearchSink;
  stream: EventStream;
}

export interface SearchSink {
  indexCis(tenantId: string, cis: readonly Ci[]): Promise<void>;
  /** Drops the tenant's index (tenant off-boarding, replay resets). */
  dropTenant(tenantId: string): Promise<void>;
}

export interface EventStream {
  publish(envelope: EventEnvelope): Promise<void>;
  publishMany(envelopes: readonly EventEnvelope[]): Promise<void>;
  close(): Promise<void>;
}

function ciFromEvent(e: EventEnvelope): Ci | null {
  const ci = (e.data as { ci?: Ci }).ci;
  return ci ?? null;
}

function relationshipFromEvent(e: EventEnvelope): Relationship | null {
  const r = (e.data as { relationship?: Relationship }).relationship;
  return r ?? null;
}

export function toGraphCi(ci: Ci): GraphCi {
  const tier = ci.attributes['tier'];
  return {
    id: ci.id,
    tenantId: ci.tenantId,
    type: ci.type,
    layer: ci.layer,
    name: ci.name,
    displayName: ci.displayName,
    lifecycle: ci.lifecycle,
    health: 'unknown',
    tier: typeof tier === 'number' ? tier : null,
    validFrom: ci.validFrom,
    validTo: ci.validTo,
  };
}

export function toGraphRelationship(r: Relationship): GraphRelationship {
  return {
    id: r.id,
    tenantId: r.tenantId,
    type: r.type,
    fromCiId: r.fromCiId,
    toCiId: r.toCiId,
    validFrom: r.validFrom,
    validTo: r.validTo,
  };
}

async function deliverMemgraph(graph: GraphRepository, events: readonly EventEnvelope[]): Promise<void> {
  const cis: GraphCi[] = [];
  const rels: GraphRelationship[] = [];
  const retiredCis: Ci[] = [];
  const retiredRels: Relationship[] = [];
  for (const e of events) {
    if (
      e.type === 'openmap.ci.created' ||
      e.type === 'openmap.ci.updated' ||
      e.type === 'openmap.ci.labelled'
    ) {
      const ci = ciFromEvent(e);
      if (ci) cis.push(toGraphCi(ci));
    } else if (e.type === 'openmap.ci.retired') {
      const ci = ciFromEvent(e);
      if (ci) retiredCis.push(ci);
    } else if (e.type === 'openmap.relationship.created') {
      const r = relationshipFromEvent(e);
      if (r) rels.push(toGraphRelationship(r));
    } else if (e.type === 'openmap.relationship.retired') {
      const r = relationshipFromEvent(e);
      if (r) retiredRels.push(r);
    }
  }
  if (cis.length) await graph.upsertCis(cis);
  if (rels.length) await graph.upsertRelationships(rels);
  for (const ci of retiredCis)
    await graph.retireCi(ci.tenantId, ci.id, ci.validTo ?? new Date().toISOString());
  for (const r of retiredRels)
    await graph.retireRelationship(r.tenantId, r.id, r.validTo ?? new Date().toISOString());
}

function chDate(iso: string): string {
  return iso.replace('T', ' ').replace('Z', '');
}

async function deliverClickHouse(
  ch: ClickHouseClient,
  database: string,
  events: readonly EventEnvelope[],
  sequences: ReadonlyMap<string, bigint>,
): Promise<void> {
  const eventRows = events.map((e) => ({
    sequence: Number(sequences.get(e.id) ?? 0n),
    event_id: e.id,
    tenant_id: e.tenantid,
    type: e.type,
    source: e.source,
    subject: e.subject,
    time: chDate(e.time),
    traceparent: e.traceparent ?? '',
    data: JSON.stringify(e.data),
    envelope: JSON.stringify(e),
  }));
  await ch.insert({ table: database + '.events', values: eventRows, format: 'JSONEachRow' });
  const ciRows = events
    .map(ciFromEvent)
    .filter((c): c is Ci => c !== null)
    .map((c) => ({
      tenant_id: c.tenantId,
      ci_id: c.id,
      type: c.type,
      layer: c.layer,
      lifecycle: c.lifecycle,
      name: c.name,
      display_name: c.displayName,
      identity_key: Object.values(c.identity).join('|').toLowerCase(),
      identity: JSON.stringify(c.identity),
      attributes: JSON.stringify(c.attributes),
      tags: c.tags,
      user_label: c.userLabel ? JSON.stringify(c.userLabel) : '',
      source_collector_id: c.source.collectorId,
      source_node_id: c.source.nodeId,
      source_run_id: c.source.runId,
      source_confidence: c.source.confidence,
      observed_at: chDate(c.observedAt),
      valid_from: chDate(c.validFrom),
      valid_to: c.validTo ? chDate(c.validTo) : null,
    }));
  if (ciRows.length)
    await ch.insert({ table: database + '.ci_history', values: ciRows, format: 'JSONEachRow' });
  const relRows = events
    .map(relationshipFromEvent)
    .filter((r): r is Relationship => r !== null)
    .map((r) => ({
      tenant_id: r.tenantId,
      relationship_id: r.id,
      type: r.type,
      from_ci_id: r.fromCiId,
      to_ci_id: r.toCiId,
      attributes: JSON.stringify(r.attributes),
      source_collector_id: r.source.collectorId,
      source_node_id: r.source.nodeId,
      source_run_id: r.source.runId,
      source_confidence: r.source.confidence,
      observed_at: chDate(r.observedAt),
      valid_from: chDate(r.validFrom),
      valid_to: r.validTo ? chDate(r.validTo) : null,
    }));
  if (relRows.length)
    await ch.insert({ table: database + '.relationship_history', values: relRows, format: 'JSONEachRow' });
  const auditRows = events.map(auditRowFromEvent).filter((r): r is AuditRow => r !== null);
  if (auditRows.length)
    await ch.insert({ table: database + '.audit_log', values: auditRows, format: 'JSONEachRow' });
  const metricRows = events.flatMap(metricRowsFromEvent);
  if (metricRows.length)
    await ch.insert({ table: database + '.metrics', values: metricRows, format: 'JSONEachRow' });
  const healthRows = events.map(healthRowFromEvent).filter((r): r is HealthRow => r !== null);
  if (healthRows.length)
    await ch.insert({
      table: database + '.service_health_history',
      values: healthRows,
      format: 'JSONEachRow',
    });
}

interface HealthRow {
  tenant_id: string;
  service_ci_id: string;
  health: string;
  score: number;
  cause_ci_id: string | null;
  sla_budget_remaining_minutes: number | null;
  ts: string;
}

const healthEventDataSchema = z.object({
  state: z.enum(HEALTH_STATES),
  rootCauseIds: z.array(z.string()).optional(),
  budgetRemainingMinutes: z.number().nullable().optional(),
});

/** REQ-BSM-008 ADR-024 — `openmap.bsm.health.changed` events become `service_health_history` rows, the availability source. */
export function healthRowFromEvent(e: EventEnvelope): HealthRow | null {
  if (e.type !== 'openmap.bsm.health.changed') return null;
  const parsed = healthEventDataSchema.safeParse(e.data);
  if (!parsed.success || !z.uuid().safeParse(e.subject).success) return null;
  const cause = parsed.data.rootCauseIds?.[0];
  return {
    tenant_id: e.tenantid,
    service_ci_id: e.subject,
    health: parsed.data.state,
    score: SLA.healthScore[parsed.data.state],
    cause_ci_id: cause !== undefined && z.uuid().safeParse(cause).success ? cause : null,
    sla_budget_remaining_minutes: parsed.data.budgetRemainingMinutes ?? null,
    ts: chDate(e.time),
  };
}

interface MetricRow {
  tenant_id: string;
  ci_id: string;
  metric: string;
  ts: string;
  value: number;
  unit: string;
  labels: Record<string, string>;
  source_run_id: string;
}

const resolvedSampleSchema = metricSampleSchema.omit({ ci: true }).extend({ ciId: z.uuid() });
const metricEventDataSchema = z.object({ runId: z.uuid(), samples: z.array(resolvedSampleSchema) });

/** REQ-CMDB-038 ADR-016 — `openmap.metric.sampled` events become `metrics` rows, one per sample. */
export function metricRowsFromEvent(e: EventEnvelope): MetricRow[] {
  if (e.type !== 'openmap.metric.sampled') return [];
  const parsed = metricEventDataSchema.safeParse(e.data);
  if (!parsed.success) return [];
  return parsed.data.samples.map((s) => ({
    tenant_id: e.tenantid,
    ci_id: s.ciId,
    metric: s.metric,
    ts: chDate(s.ts),
    value: s.value,
    unit: s.unit,
    labels: s.labels,
    source_run_id: parsed.data.runId,
  }));
}

interface AuditRow {
  tenant_id: string;
  id: string;
  actor: string;
  action: string;
  subject_type: string;
  subject_id: string;
  details: string;
  traceparent: string;
  at: string;
}

/** REQ-SEC-005 — `openmap.audit.action` events become audit_log rows (the retention and analytics copy). */
export function auditRowFromEvent(e: EventEnvelope): AuditRow | null {
  if (e.type !== 'openmap.audit.action') return null;
  const d = e.data as {
    auditId?: unknown;
    actor?: unknown;
    action?: unknown;
    subjectType?: unknown;
    subjectId?: unknown;
    details?: unknown;
    at?: unknown;
  };
  if (typeof d.auditId !== 'string' || typeof d.action !== 'string') return null;
  return {
    tenant_id: e.tenantid,
    id: d.auditId,
    actor: typeof d.actor === 'string' ? d.actor : '',
    action: d.action,
    subject_type: typeof d.subjectType === 'string' ? d.subjectType : '',
    subject_id: typeof d.subjectId === 'string' ? d.subjectId : '',
    details: JSON.stringify(d.details ?? {}),
    traceparent: e.traceparent ?? '',
    at: chDate(typeof d.at === 'string' ? d.at : e.time),
  };
}

export function createMeilisearchSink(
  env: Pick<Env, 'MEILI_URL' | 'MEILI_MASTER_KEY'>,
  fetchImpl: typeof fetch = fetch,
): SearchSink {
  const base = env.MEILI_URL.endsWith('/') ? env.MEILI_URL : env.MEILI_URL + '/';
  const headers = { authorization: 'Bearer ' + env.MEILI_MASTER_KEY, 'content-type': 'application/json' };
  return {
    async indexCis(tenantId, cis) {
      if (cis.length === 0) return;
      const index = RECONCILER.searchIndexPrefix + tenantId;
      const docs = cis.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        displayName: c.displayName,
        type: c.type,
        layer: c.layer,
        lifecycle: c.lifecycle,
        tags: c.tags,
        identity: Object.values(c.identity),
        text: Object.values(c.attributes)
          .filter((v) => typeof v === 'string')
          .join(' '),
      }));
      const res = await fetchImpl(new URL('indexes/' + index + '/documents?primaryKey=id', base), {
        method: 'POST',
        headers,
        body: JSON.stringify(docs),
      });
      if (!res.ok) throw new Error('meilisearch returned ' + String(res.status));
    },
    async dropTenant(tenantId) {
      const res = await fetchImpl(new URL('indexes/' + RECONCILER.searchIndexPrefix + tenantId, base), {
        method: 'DELETE',
        headers,
      });
      if (!res.ok && res.status !== HTTP.status.notFound)
        throw new Error('meilisearch returned ' + String(res.status));
    },
  };
}

export function createEventStream(env: Pick<Env, 'VALKEY_URL'>): EventStream {
  const connection = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
  const queue = new Queue<EventEnvelope>(RECONCILER.eventStreamQueue, { connection });
  const opts = (envelope: EventEnvelope) => ({
    jobId: envelope.id,
    removeOnComplete: { count: RECONCILER.outboxBatchSize * RECONCILER.resultsConcurrency },
    removeOnFail: { count: RECONCILER.outboxBatchSize },
  });
  return {
    async publish(envelope) {
      await queue.add(envelope.type, envelope, opts(envelope));
    },
    async publishMany(envelopes) {
      if (envelopes.length === 0) return;
      await queue.addBulk(envelopes.map((e) => ({ name: e.type, data: e, opts: opts(e) })));
    },
    async close() {
      await queue.close();
      await connection.quit();
    },
  };
}

export function createClickHouse(
  env: Pick<Env, 'CLICKHOUSE_URL' | 'CLICKHOUSE_USER' | 'CLICKHOUSE_PASSWORD' | 'CLICKHOUSE_DB'>,
): ClickHouseClient {
  // Async inserts let ClickHouse coalesce the dispatcher's small batches server-side; waiting keeps
  // the outbox acknowledgement truthful (a row is only marked delivered once it is durable).
  return createClient({
    url: env.CLICKHOUSE_URL,
    username: env.CLICKHOUSE_USER,
    password: env.CLICKHOUSE_PASSWORD,
    database: env.CLICKHOUSE_DB,
    clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 },
  });
}

export interface DispatchReport {
  claimed: number;
  delivered: number;
  failures: Array<{ target: OutboxTarget; error: string }>;
}

/** One dispatcher tick: claim a batch of undelivered events and push each pending target. */
export async function dispatchOnce(
  prisma: PrismaClient,
  sinks: Sinks,
  database: string,
): Promise<DispatchReport> {
  const rows = await prisma.outboxEvent.findMany({
    where: { deliveredAt: null },
    orderBy: { sequence: 'asc' },
    take: RECONCILER.outboxBatchSize,
  });
  if (rows.length === 0) return { claimed: 0, delivered: 0, failures: [] };
  const events = rows.map((r) => eventEnvelopeSchema.parse(r.envelope));
  const sequences = new Map(rows.map((r) => [r.eventId, r.sequence] as const));
  const failures: DispatchReport['failures'] = [];
  const succeeded = new Set<OutboxTarget>();
  const attempt = async (target: OutboxTarget, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      succeeded.add(target);
    } catch (err) {
      failures.push({ target, error: err instanceof Error ? err.message : String(err) });
    }
  };
  const byTenant = new Map<string, Ci[]>();
  for (const e of events) {
    const ci = ciFromEvent(e);
    if (ci) byTenant.set(e.tenantid, [...(byTenant.get(e.tenantid) ?? []), ci]);
  }
  // The targets are independent stores, so a batch reaches them concurrently; each keeps its own order and its own
  // success or failure (REQ-CORE-013 scale-1 replay: one after another, dispatch was half of the run).
  await Promise.all([
    attempt('memgraph', () =>
      deliverMemgraph(
        sinks.graph,
        events.filter((_, i) => rows[i]!.pending.includes('memgraph')),
      ),
    ),
    attempt('clickhouse', () =>
      deliverClickHouse(
        sinks.clickhouse,
        database,
        events.filter((_, i) => rows[i]!.pending.includes('clickhouse')),
        sequences,
      ),
    ),
    attempt('meilisearch', async () => {
      for (const [tenantId, cis] of byTenant) await sinks.search.indexCis(tenantId, cis);
    }),
    attempt('bsm', () =>
      sinks.stream.publishMany(
        events.filter((_, i) => rows[i]!.pending.includes('bsm') || rows[i]!.pending.includes('websocket')),
      ),
    ),
  ]);
  if (succeeded.has('bsm')) succeeded.add('websocket');
  const allTargets: OutboxTarget[] = ['memgraph', 'clickhouse', 'meilisearch', 'websocket', 'bsm'];
  if (failures.length === 0 && allTargets.every((t) => succeeded.has(t))) {
    // Common case: everything landed, one statement closes the whole batch.
    await prisma.outboxEvent.updateMany({
      where: { sequence: { in: rows.map((r) => r.sequence) } },
      data: { pending: [], attempts: { increment: 1 }, deliveredAt: new Date(), lastError: null },
    });
    return { claimed: rows.length, delivered: rows.length, failures };
  }
  let delivered = 0;
  const lastError = failures.map((f) => f.target + ': ' + f.error).join('; ');
  for (const row of rows) {
    const remaining = row.pending.filter((t) => !succeeded.has(t));
    const done = remaining.length === 0;
    if (done) delivered++;
    await prisma.outboxEvent.update({
      where: { sequence: row.sequence },
      data: {
        pending: remaining,
        attempts: { increment: 1 },
        deliveredAt: done ? new Date() : null,
        lastError: lastError.length ? lastError : null,
      },
    });
  }
  return { claimed: rows.length, delivered, failures };
}
