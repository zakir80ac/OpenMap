// T-632 REQ-INT-012 (ADR-073) — monitoring alerts on CI health: the worst firing effect per CI, the overlay on observed
// health, which events wake the sync, and one sync over an in-test store: a firing alert takes its CI down, a second
// lesser alert does not lift it, resolving the worse one leaves it degraded, resolving both restores the observed
// health, and a remapped alert leaves the CI it was counted on.
import { describe, expect, it } from 'vitest';
import { MONITORING } from '@openmap/constants';
import type { EventEnvelope } from '@openmap/contracts';
import type { PrismaClient } from '@openmap/db';
import type { GraphRepository } from '@openmap/graph';
import type { Health } from '../core/propagate.js';
import { ciAlertsOf, createMonitoringHealth, wakesMonitoring, withAlerts } from './monitoring.js';

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const E1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const E2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

describe('overlay rules', () => {
  it('takes the worst firing effect and its delivery events', () => {
    expect(ciAlertsOf([])).toBeNull();
    expect(ciAlertsOf([{ id: '1', ciId: HOST, effect: null, lastEventId: E1 }])).toBeNull();
    expect(
      ciAlertsOf([
        { id: '1', ciId: HOST, effect: 'degraded', lastEventId: E1 },
        { id: '2', ciId: HOST, effect: 'down', lastEventId: E2 },
        { id: '3', ciId: HOST, effect: 'down', lastEventId: E2 },
      ]),
    ).toEqual({ effect: 'down', eventIds: [E1, E2] });
  });

  it('never makes observed health better', () => {
    expect(withAlerts('healthy', null)).toBe('healthy');
    expect(withAlerts('healthy', 'degraded')).toBe('degraded');
    expect(withAlerts('unknown', 'down')).toBe('down');
    expect(withAlerts('down', 'degraded')).toBe('down');
  });

  it('wakes on inbound monitoring deliveries, mappings and clears only', () => {
    const e = (type: EventEnvelope['type'], data: Record<string, unknown>): EventEnvelope =>
      ({ specversion: '1.0', id: E1, source: '/t', type, subject: 's', time: '2026-11-10T12:00:00.000Z', datacontenttype: 'application/json', dataschema: 'x', tenantid: T, data }) as EventEnvelope;
    expect(wakesMonitoring(e('openmap.integration.delivery.succeeded', { kind: MONITORING.deliveryKind }))).toBe(true);
    expect(wakesMonitoring(e('openmap.integration.delivery.succeeded', { probe: true }))).toBe(false);
    expect(wakesMonitoring(e('openmap.audit.action', { action: MONITORING.auditActions.mapped }))).toBe(true);
    expect(wakesMonitoring(e('openmap.audit.action', { action: 'integration.updated' }))).toBe(false);
    expect(wakesMonitoring(e('openmap.ci.updated', {}))).toBe(false);
  });
});

interface AlertRow {
  id: string;
  tenantId: string;
  ciId: string | null;
  status: string;
  effect: string | null;
  lastEventId: string | null;
  updatedAt: Date;
}

/** An in-test stand-in for the three Prisma calls the sync makes, over plain rows. */
function store(rows: AlertRow[]) {
  const ci = { id: HOST, type: 'host', attributes: { status: 'ok' }, observedAt: new Date(), lifecycle: 'active' };
  const other = { ...ci, id: OTHER };
  const prisma = {
    $executeRaw: () => Promise.resolve(0),
    monitoringAlert: {
      findMany: (q: { where: { status?: string; ciId?: { in?: string[]; not?: null }; updatedAt?: { gt: Date } } }) =>
        Promise.resolve(
          rows.filter(
            (r) =>
              (q.where.status === undefined || r.status === q.where.status) &&
              (q.where.ciId?.in === undefined || (r.ciId !== null && q.where.ciId.in.includes(r.ciId))) &&
              (q.where.ciId?.not !== null || r.ciId !== null) &&
              (q.where.updatedAt === undefined || r.updatedAt > q.where.updatedAt.gt),
          ),
        ),
    },
    ci: { findMany: (q: { where: { id: { in: string[] } } }) => Promise.resolve([ci, other].filter((c) => q.where.id.in.includes(c.id))) },
  } as unknown as PrismaClient;
  const health = new Map<string, Health>();
  const graph = {
    setHealth: (_t: string, id: string, h: Health) => {
      health.set(id, h);
      return Promise.resolve();
    },
  } as unknown as GraphRepository;
  return { prisma, graph, health };
}

describe('createMonitoringHealth.sync', () => {
  it('applies, worsens, eases and clears CI health as alerts fire and resolve', async () => {
    let clock = Date.parse('2026-11-10T12:00:00.000Z');
    const tick = (): Date => new Date((clock += MONITORING.syncOverlapMs * 2));
    const rows: AlertRow[] = [{ id: 'a1', tenantId: T, ciId: HOST, status: 'firing', effect: 'down', lastEventId: E1, updatedAt: tick() }];
    const s = store(rows);
    const m = createMonitoringHealth({ prisma: s.prisma, graph: s.graph, healthMap: (_t, ids) => Promise.resolve(new Map(ids.map((id) => [id, s.health.get(id) ?? 'unknown']))), now: () => new Date(clock) });

    const first = await m.sync();
    expect(first).toMatchObject({ read: 1, healthChanged: 1, tenants: [T] });
    expect(s.health.get(HOST)).toBe('down');
    expect(m.overlay.effect(T, HOST)).toBe('down');
    expect(m.overlay.eventIds(T, [HOST, OTHER])).toEqual([E1]);

    rows.push({ id: 'a2', tenantId: T, ciId: HOST, status: 'firing', effect: 'degraded', lastEventId: E2, updatedAt: tick() });
    expect((await m.sync()).healthChanged).toBe(0);
    expect(s.health.get(HOST)).toBe('down');

    Object.assign(rows[0] as AlertRow, { status: 'resolved', updatedAt: tick() });
    await m.sync();
    expect(s.health.get(HOST)).toBe('degraded');

    // The lesser alert is remapped to another CI: the host returns to its observed health, the other CI degrades.
    Object.assign(rows[1] as AlertRow, { ciId: OTHER, updatedAt: tick() });
    const remapped = await m.sync();
    expect(remapped.healthChanged).toBe(2);
    expect(s.health.get(HOST)).toBe('healthy');
    expect(s.health.get(OTHER)).toBe('degraded');
    expect(m.overlay.effect(T, HOST)).toBeNull();
  });
});
