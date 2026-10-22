// T-095 REQ-SEC-005 — the audit service writes each entry exactly once, with the event's trace id already on the
// row (audit_logs forbids UPDATE), publishes the matching event in the same transaction, redacts credential-like
// arguments and counts the entry in the Prometheus metric.
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../db/prisma.service.js';
import { MetricsService } from '../metrics/metrics.service.js';
import type { OutboxService } from '../outbox/outbox.service.js';
import { AuditService, redact } from './audit.service.js';

const tenantId = '2b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e';
const traceparent = '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01';

function harness() {
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data, details: data['details'] }));
  const update = vi.fn();
  const emit = vi.fn(async (input: { type: string; subject: string; data: Record<string, unknown> }) => ({ ...input, id: 'event', traceparent }));
  const outbox = {
    transaction: vi.fn(async (_tenant: string, fn: (ctx: { tx: unknown; emit: typeof emit }) => Promise<unknown>) => fn({ tx: { auditLog: { create, update } }, emit })),
  } as unknown as OutboxService;
  const metrics = new MetricsService();
  const service = new AuditService({} as PrismaService, outbox, metrics);
  return { service, create, update, emit, metrics };
}

describe('AuditService.record', () => {
  it('emits the event first and writes the row once with the trace id', async () => {
    const h = harness();
    const entry = await h.service.record({ tenantId, username: 'admin', requestId: 'req-1' }, 'labelCi', 'Ci', 'ci-1', { input: { title: 'Web', password: 'hunter2' } });

    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.update).not.toHaveBeenCalled();
    const emitted = h.emit.mock.calls[0]![0];
    const created = h.create.mock.calls[0]![0].data;
    expect(emitted.type).toBe('openmap.audit.action');
    expect(emitted.subject).toBe('Ci/ci-1');
    expect(created['id']).toBe(emitted.data['auditId']);
    expect(created['traceparent']).toBe(traceparent);
    expect(created['details']).toEqual({ input: { title: 'Web', password: '[redacted]' } });
    expect(entry.traceparent).toBe(traceparent);
    expect(entry.action).toBe('labelCi');

    const rendered = await h.metrics.render();
    expect(rendered).toContain('openmap_audit_entries_total{action="labelCi"} 1');
  });

  it('redacts credential-like keys at any depth and leaves everything else intact', () => {
    expect(redact({ apiKey: 'k', nested: [{ clientSecret: 's', name: 'n' }], count: 2 })).toEqual({ apiKey: '[redacted]', nested: [{ clientSecret: '[redacted]', name: 'n' }], count: 2 });
  });
});
