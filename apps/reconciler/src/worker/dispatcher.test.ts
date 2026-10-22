// T-091 REQ-CORE-005 — one dispatcher tick fans a claimed outbox batch out to every target (Memgraph, ClickHouse,
// Meilisearch, the event stream that feeds the BSM engine and the API's WebSocket fan-out) and closes the rows; a
// failing target stays pending on its rows while the others are acknowledged.
import { describe, expect, it, vi } from 'vitest';
import type { ClickHouseClient } from '@clickhouse/client';
import type { Ci, EventEnvelope, Relationship } from '@openmap/contracts';
import type { PrismaClient } from '@openmap/db';
import type { GraphRepository } from '@openmap/graph';
import { auditRowFromEvent, dispatchOnce, toGraphCi, type OutboxTarget, type Sinks } from './dispatcher.js';

const tenantId = '2b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e';
const now = '2026-10-22T09:00:00.000Z';
const source = { collectorId: 'port_scan', nodeId: 'node-hq-01', runId: '3b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e', confidence: 0.9 };

const ci: Ci = {
  id: '4b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e',
  tenantId,
  type: 'host',
  identity: { fqdn: 'web-01.example' },
  name: 'web-01',
  displayName: 'web-01.example',
  code: 'OS-WEB-01',
  layer: 'os',
  userLabel: null,
  lifecycle: 'discovered',
  attributes: { tier: 2, os: 'linux' },
  tags: ['web'],
  externalIds: [],
  source,
  observedAt: now,
  validFrom: now,
  validTo: null,
  checksum: 'a'.repeat(64),
};

const relationship: Relationship = {
  id: '5b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e',
  tenantId,
  type: 'RUNS_ON',
  fromCiId: ci.id,
  toCiId: '6b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e',
  attributes: {},
  source,
  observedAt: now,
  validFrom: now,
  validTo: null,
};

function envelope(id: string, type: EventEnvelope['type'], data: Record<string, unknown>): EventEnvelope {
  return { specversion: '1.0', id, source: '/openmap/reconciler', type, subject: ci.id, time: now, datacontenttype: 'application/json', dataschema: 'https://openmap.dev/contracts/event-envelope/0.1.0', tenantid: tenantId, traceparent: '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01', data };
}

const allTargets: OutboxTarget[] = ['memgraph', 'clickhouse', 'meilisearch', 'websocket', 'bsm'];

function rows() {
  return [
    { sequence: 1n, eventId: '7b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e', pending: [...allTargets], envelope: envelope('7b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e', 'openmap.ci.created', { ci }) },
    { sequence: 2n, eventId: '8b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e', pending: [...allTargets], envelope: envelope('8b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e', 'openmap.relationship.created', { relationship }) },
    {
      sequence: 3n,
      eventId: '9b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e',
      pending: [...allTargets],
      envelope: envelope('9b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e', 'openmap.audit.action', { auditId: 'ab2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e', actor: 'admin', action: 'labelCi', subjectType: 'ci', subjectId: ci.id, details: { title: 'Web' }, at: now }),
    },
  ];
}

function harness(insert: ClickHouseClient['insert']) {
  const updateMany = vi.fn(async () => ({ count: 3 }));
  const update = vi.fn(async () => ({}));
  const prisma = { outboxEvent: { findMany: vi.fn(async () => rows()), updateMany, update } } as unknown as PrismaClient;
  const graph = { upsertCis: vi.fn(async () => undefined), upsertRelationships: vi.fn(async () => undefined), retireCi: vi.fn(async () => undefined), retireRelationship: vi.fn(async () => undefined) } as unknown as GraphRepository;
  const search = { indexCis: vi.fn(async () => undefined), dropTenant: vi.fn(async () => undefined) };
  const stream = { publish: vi.fn(async () => undefined), publishMany: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  const sinks: Sinks = { graph, clickhouse: { insert } as unknown as ClickHouseClient, search, stream };
  return { prisma, sinks, graph, search, stream, updateMany, update };
}

describe('outbox dispatcher', () => {
  it('delivers a batch to every target and closes the rows in one statement', async () => {
    const insert = vi.fn(async () => ({})) as unknown as ClickHouseClient['insert'];
    const h = harness(insert);
    const report = await dispatchOnce(h.prisma, h.sinks, 'openmap');

    expect(report).toEqual({ claimed: 3, delivered: 3, failures: [] });
    expect(h.graph.upsertCis).toHaveBeenCalledWith([toGraphCi(ci)]);
    expect(h.graph.upsertRelationships).toHaveBeenCalledWith([expect.objectContaining({ id: relationship.id, type: 'RUNS_ON' })]);
    const tables = (insert as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { table: string; values: unknown[] }));
    expect(tables.map((t) => t.table).sort()).toEqual(['openmap.audit_log', 'openmap.ci_history', 'openmap.events', 'openmap.relationship_history']);
    expect(tables.find((t) => t.table === 'openmap.events')?.values).toHaveLength(3);
    expect(tables.find((t) => t.table === 'openmap.audit_log')?.values).toEqual([expect.objectContaining({ action: 'labelCi', actor: 'admin', subject_id: ci.id })]);
    expect(h.search.indexCis).toHaveBeenCalledWith(tenantId, [ci]);
    expect(h.stream.publishMany).toHaveBeenCalledTimes(1);
    expect((h.stream.publishMany.mock.calls[0] as unknown[])[0]).toHaveLength(3);
    expect(h.updateMany).toHaveBeenCalledTimes(1);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('keeps only the failed target pending and acknowledges the rest', async () => {
    const insert = vi.fn(async () => {
      throw new Error('clickhouse down');
    }) as unknown as ClickHouseClient['insert'];
    const h = harness(insert);
    const report = await dispatchOnce(h.prisma, h.sinks, 'openmap');

    expect(report.claimed).toBe(3);
    expect(report.delivered).toBe(0);
    expect(report.failures).toEqual([{ target: 'clickhouse', error: 'clickhouse down' }]);
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledTimes(3);
    for (const call of h.update.mock.calls as unknown as Array<[{ data: { pending: OutboxTarget[]; deliveredAt: Date | null; lastError: string | null } }]>) {
      expect(call[0].data.pending).toEqual(['clickhouse']);
      expect(call[0].data.deliveredAt).toBeNull();
      expect(call[0].data.lastError).toContain('clickhouse down');
    }
    expect(h.graph.upsertCis).toHaveBeenCalledTimes(1);
    expect(h.stream.publishMany).toHaveBeenCalledTimes(1);
  });

  it('maps only audit events to audit_log rows', () => {
    expect(auditRowFromEvent(envelope('7b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e', 'openmap.ci.created', { ci }))).toBeNull();
    const row = auditRowFromEvent(rows()[2]!.envelope);
    expect(row).toMatchObject({ tenant_id: tenantId, actor: 'admin', action: 'labelCi', subject_type: 'ci', subject_id: ci.id, at: '2026-10-22 09:00:00.000' });
    expect(JSON.parse(row?.details ?? '{}')).toEqual({ title: 'Web' });
  });
});
