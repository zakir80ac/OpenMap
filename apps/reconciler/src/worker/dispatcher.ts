// REQ-CORE-005 — outbox dispatcher: delivers every pending event to Memgraph, ClickHouse and
// Meilisearch, and republishes it on the event stream for the BSM engine and the API's WebSocket
// fan-out. Each target is removed from `pending` on success, so a failing store never blocks the others.
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { RECONCILER } from '@openmap/constants';
import type { Env } from '@openmap/config';
import { eventEnvelopeSchema, type Ci, type EventEnvelope, type Relationship } from '@openmap/contracts';
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
}

export interface EventStream {
  publish(envelope: EventEnvelope): Promise<void>;
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
  return { id: r.id, tenantId: r.tenantId, type: r.type, fromCiId: r.fromCiId, toCiId: r.toCiId, validFrom: r.validFrom, validTo: r.validTo };
}

async function deliverMemgraph(graph: GraphRepository, events: readonly EventEnvelope[]): Promise<void> {
  const cis: GraphCi[] = [];
  const rels: GraphRelationship[] = [];
  const retiredCis: Ci[] = [];
  const retiredRels: Relationship[] = [];
  for (const e of events) {
    if (e.type === 'openmap.ci.created' || e.type === 'openmap.ci.updated' || e.type === 'openmap.ci.labelled') {
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
  for (const ci of retiredCis) await graph.retireCi(ci.tenantId, ci.id, ci.validTo ?? new Date().toISOString());
  for (const r of retiredRels) await graph.retireRelationship(r.tenantId, r.id, r.validTo ?? new Date().toISOString());
}

function chDate(iso: string): string {
  return iso.replace('T', ' ').replace('Z', '');
}

async function deliverClickHouse(ch: ClickHouseClient, database: string, events: readonly EventEnvelope[], sequences: ReadonlyMap<string, bigint>): Promise<void> {
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
      tenant_id: c.tenantId, ci_id: c.id, type: c.type, layer: c.layer, lifecycle: c.lifecycle, name: c.name, display_name: c.displayName,
      identity_key: Object.values(c.identity).join('|').toLowerCase(), identity: JSON.stringify(c.identity), attributes: JSON.stringify(c.attributes), tags: c.tags,
      user_label: c.userLabel ? JSON.stringify(c.userLabel) : '', source_collector_id: c.source.collectorId, source_node_id: c.source.nodeId, source_run_id: c.source.runId,
      source_confidence: c.source.confidence, observed_at: chDate(c.observedAt), valid_from: chDate(c.validFrom), valid_to: c.validTo ? chDate(c.validTo) : null,
    }));
  if (ciRows.length) await ch.insert({ table: database + '.ci_history', values: ciRows, format: 'JSONEachRow' });
  const relRows = events
    .map(relationshipFromEvent)
    .filter((r): r is Relationship => r !== null)
    .map((r) => ({
      tenant_id: r.tenantId, relationship_id: r.id, type: r.type, from_ci_id: r.fromCiId, to_ci_id: r.toCiId, attributes: JSON.stringify(r.attributes),
      source_collector_id: r.source.collectorId, source_node_id: r.source.nodeId, source_run_id: r.source.runId, source_confidence: r.source.confidence,
      observed_at: chDate(r.observedAt), valid_from: chDate(r.validFrom), valid_to: r.validTo ? chDate(r.validTo) : null,
    }));
  if (relRows.length) await ch.insert({ table: database + '.relationship_history', values: relRows, format: 'JSONEachRow' });
}

export function createMeilisearchSink(env: Pick<Env, 'MEILI_URL' | 'MEILI_MASTER_KEY'>, fetchImpl: typeof fetch = fetch): SearchSink {
  const base = env.MEILI_URL.endsWith('/') ? env.MEILI_URL : env.MEILI_URL + '/';
  const headers = { authorization: 'Bearer ' + env.MEILI_MASTER_KEY, 'content-type': 'application/json' };
  return {
    async indexCis(tenantId, cis) {
      if (cis.length === 0) return;
      const index = RECONCILER.searchIndexPrefix + tenantId;
      const docs = cis.map((c) => ({ id: c.id, code: c.code, name: c.name, displayName: c.displayName, type: c.type, layer: c.layer, lifecycle: c.lifecycle, tags: c.tags, identity: Object.values(c.identity), text: Object.values(c.attributes).filter((v) => typeof v === 'string').join(' ') }));
      const res = await fetchImpl(new URL('indexes/' + index + '/documents?primaryKey=id', base), { method: 'POST', headers, body: JSON.stringify(docs) });
      if (!res.ok) throw new Error('meilisearch returned ' + String(res.status));
    },
  };
}

export function createEventStream(env: Pick<Env, 'VALKEY_URL'>): EventStream {
  const connection = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
  const queue = new Queue<EventEnvelope>(RECONCILER.eventStreamQueue, { connection });
  return {
    async publish(envelope) {
      await queue.add(envelope.type, envelope, { jobId: envelope.id, removeOnComplete: { count: RECONCILER.outboxBatchSize * RECONCILER.resultsConcurrency }, removeOnFail: { count: RECONCILER.outboxBatchSize } });
    },
    async close() {
      await queue.close();
      await connection.quit();
    },
  };
}

export function createClickHouse(env: Pick<Env, 'CLICKHOUSE_URL' | 'CLICKHOUSE_USER' | 'CLICKHOUSE_PASSWORD' | 'CLICKHOUSE_DB'>): ClickHouseClient {
  return createClient({ url: env.CLICKHOUSE_URL, username: env.CLICKHOUSE_USER, password: env.CLICKHOUSE_PASSWORD, database: env.CLICKHOUSE_DB });
}

export interface DispatchReport {
  claimed: number;
  delivered: number;
  failures: Array<{ target: OutboxTarget; error: string }>;
}

/** One dispatcher tick: claim a batch of undelivered events and push each pending target. */
export async function dispatchOnce(prisma: PrismaClient, sinks: Sinks, database: string): Promise<DispatchReport> {
  const rows = await prisma.outboxEvent.findMany({ where: { deliveredAt: null }, orderBy: { sequence: 'asc' }, take: RECONCILER.outboxBatchSize });
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
  await attempt('memgraph', () => deliverMemgraph(sinks.graph, events.filter((_, i) => rows[i]!.pending.includes('memgraph'))));
  await attempt('clickhouse', () => deliverClickHouse(sinks.clickhouse, database, events.filter((_, i) => rows[i]!.pending.includes('clickhouse')), sequences));
  await attempt('meilisearch', async () => {
    for (const [tenantId, cis] of byTenant) await sinks.search.indexCis(tenantId, cis);
  });
  await attempt('bsm', async () => {
    for (const [i, e] of events.entries()) if (rows[i]!.pending.includes('bsm') || rows[i]!.pending.includes('websocket')) await sinks.stream.publish(e);
  });
  if (succeeded.has('bsm')) succeeded.add('websocket');
  let delivered = 0;
  for (const row of rows) {
    const remaining = row.pending.filter((t) => !succeeded.has(t));
    const done = remaining.length === 0;
    if (done) delivered++;
    await prisma.outboxEvent.update({
      where: { sequence: row.sequence },
      data: { pending: remaining, attempts: { increment: 1 }, deliveredAt: done ? new Date() : null, lastError: failures.length ? failures.map((f) => f.target + ': ' + f.error).join('; ') : null },
    });
  }
  return { claimed: rows.length, delivered, failures };
}
