// REQ-INT-012 (ADR-073) — monitoring alerts on CI health. The API writes each alert from Alertmanager, Zabbix, Nagios,
// Datadog, SolarWinds or Splunk as a monitoring_alerts row (resolved to a CI, with the health it imposes while
// firing). This module keeps the firing alerts' effects per CI in memory (the overlay), re-reads rows changed since
// the newest change it has seen (woken by the ingest's delivery event, and on an interval so nothing is missed), clears
// point-in-time alerts whose time to live ran out, and sets each affected CI's graph health to the worse of what was
// observed (deriveHealth over the stored CI) and what its alerts say. The engine applies the same overlay when CI
// events re-derive health, so an observation cannot hide a firing alert, and correlates the alerts' delivery events
// into the incidents it opens.
import { MONITORING } from '@openmap/constants';
import { MONITORING_EFFECTS, type Ci, type EventEnvelope, type MonitoringEffect } from '@openmap/contracts';
import { Prisma, type PrismaClient } from '@openmap/db';
import type { GraphRepository } from '@openmap/graph';
import { worst, type Health } from '../core/propagate.js';
import { deriveHealth } from './health-rules.js';

const FIRING = 'firing';
const DELIVERY_SUCCEEDED = 'openmap.integration.delivery.succeeded';
const AUDIT_ACTION = 'openmap.audit.action';
const WAKING_ACTIONS: ReadonlySet<string> = new Set(Object.values(MONITORING.auditActions));

/** What the overlay says about one CI: the worst firing effect and the delivery events behind its alerts. */
export interface CiAlerts {
  effect: MonitoringEffect;
  eventIds: string[];
}

export interface MonitoringOverlay {
  /** The worst effect of the CI's firing alerts, or null when none is firing. */
  effect(tenantId: string, ciId: string): Health | null;
  /** Delivery event ids of the firing alerts on these CIs (Incident.correlatedEventIds). */
  eventIds(tenantId: string, ciIds: readonly string[]): string[];
}

/** The health a CI shows: what was observed, made worse by a firing alert. */
export function withAlerts(observed: Health, effect: Health | null): Health {
  return effect === null ? observed : worst(observed, effect);
}

function isEffect(value: string | null): value is MonitoringEffect {
  return value !== null && (MONITORING_EFFECTS as readonly string[]).includes(value);
}

export interface FiringRow {
  id: string;
  ciId: string;
  effect: string | null;
  lastEventId: string | null;
}

/** Pure: the overlay entry of one CI from its firing alerts; null when none imposes a health. */
export function ciAlertsOf(rows: readonly FiringRow[]): CiAlerts | null {
  let effect: MonitoringEffect | null = null;
  const eventIds: string[] = [];
  for (const r of rows) {
    if (!isEffect(r.effect)) continue;
    effect = effect === null ? r.effect : (worst(effect, r.effect) as MonitoringEffect);
    if (r.lastEventId !== null) eventIds.push(r.lastEventId);
  }
  return effect === null ? null : { effect, eventIds: [...new Set(eventIds)] };
}

/** Whether an event should wake the sync now: an inbound monitoring delivery, or a mapping or a clear. */
export function wakesMonitoring(e: EventEnvelope): boolean {
  if (e.type === DELIVERY_SUCCEEDED) return e.data['kind'] === MONITORING.deliveryKind;
  if (e.type === AUDIT_ACTION) return typeof e.data['action'] === 'string' && WAKING_ACTIONS.has(e.data['action']);
  return false;
}

export interface MonitoringDeps {
  prisma: PrismaClient;
  graph: GraphRepository;
  healthMap: (tenantId: string, ids: readonly string[]) => Promise<Map<string, Health>>;
  now: () => Date;
}

export interface MonitoringSyncReport {
  /** Alerts read this pass. */
  read: number;
  /** Point-in-time alerts whose time to live ran out. */
  expired: number;
  /** CIs whose graph health this pass changed. */
  healthChanged: number;
  /** Tenants whose services need recomputing. */
  tenants: string[];
}

interface ChangedRow {
  id: string;
  tenantId: string;
  ciId: string | null;
  updatedAt: Date;
}

export function createMonitoringHealth(deps: MonitoringDeps) {
  const { prisma, graph } = deps;
  /** tenant → CI → its firing alerts' effect. */
  const overlay = new Map<string, Map<string, CiAlerts>>();
  /** alert id → the CI it was last counted on, so a remapped alert leaves its old CI. */
  const alertCi = new Map<string, { tenantId: string; ciId: string }>();
  let watermark: Date | null = null;
  let running: Promise<MonitoringSyncReport> | null = null;
  let again = false;

  const view: MonitoringOverlay = {
    effect(tenantId, ciId) {
      return overlay.get(tenantId)?.get(ciId)?.effect ?? null;
    },
    eventIds(tenantId, ciIds) {
      const byCi = overlay.get(tenantId);
      if (byCi === undefined) return [];
      return [...new Set(ciIds.flatMap((id) => byCi.get(id)?.eventIds ?? []))];
    },
  };

  async function expire(): Promise<number> {
    return prisma.$executeRaw(Prisma.sql`
      UPDATE monitoring_alerts SET status = 'resolved', "endsAt" = "expiresAt", "updatedAt" = ${deps.now()}
      WHERE status = ${FIRING} AND "expiresAt" IS NOT NULL AND "expiresAt" <= ${deps.now()}`);
  }

  async function changedRows(): Promise<ChangedRow[]> {
    if (watermark === null)
      return prisma.monitoringAlert.findMany({
        where: { status: FIRING, ciId: { not: null } },
        select: { id: true, tenantId: true, ciId: true, updatedAt: true },
      });
    const since = new Date(watermark.getTime() - MONITORING.syncOverlapMs);
    return prisma.monitoringAlert.findMany({
      where: { updatedAt: { gt: since } },
      select: { id: true, tenantId: true, ciId: true, updatedAt: true },
      orderBy: { updatedAt: 'asc' },
    });
  }

  /** Recomputes the overlay of these CIs from their firing alerts and sets graph health where it changed. */
  async function applyCis(tenantId: string, ciIds: readonly string[]): Promise<number> {
    if (ciIds.length === 0) return 0;
    const firing = await prisma.monitoringAlert.findMany({
      where: { tenantId, status: FIRING, ciId: { in: [...ciIds] } },
      select: { id: true, ciId: true, effect: true, lastEventId: true },
    });
    const byCi = overlay.get(tenantId) ?? new Map<string, CiAlerts>();
    overlay.set(tenantId, byCi);
    for (const id of ciIds) {
      const entry = ciAlertsOf(firing.filter((r): r is FiringRow => r.ciId === id));
      if (entry === null) byCi.delete(id);
      else byCi.set(id, entry);
    }
    const rows = await prisma.ci.findMany({
      where: { tenantId, id: { in: [...ciIds] }, validTo: null },
      select: { id: true, type: true, attributes: true, observedAt: true, lifecycle: true },
    });
    const current = await deps.healthMap(tenantId, ciIds);
    const now = deps.now().toISOString();
    let changed = 0;
    for (const row of rows) {
      const observed = deriveHealth(
        { type: row.type, attributes: row.attributes as Ci['attributes'], observedAt: row.observedAt.toISOString(), lifecycle: row.lifecycle },
        now,
      ).health;
      const health = withAlerts(observed, view.effect(tenantId, row.id));
      if ((current.get(row.id) ?? 'unknown') === health) continue;
      await graph.setHealth(tenantId, row.id, health);
      changed++;
    }
    return changed;
  }

  async function pass(): Promise<MonitoringSyncReport> {
    const expired = await expire();
    const rows = await changedRows();
    const affected = new Map<string, Set<string>>();
    const touch = (tenantId: string, ciId: string): void => {
      const set = affected.get(tenantId) ?? new Set<string>();
      set.add(ciId);
      affected.set(tenantId, set);
    };
    for (const r of rows) {
      const before = alertCi.get(r.id);
      if (before !== undefined && before.ciId !== r.ciId) touch(before.tenantId, before.ciId);
      if (r.ciId !== null) {
        touch(r.tenantId, r.ciId);
        alertCi.set(r.id, { tenantId: r.tenantId, ciId: r.ciId });
      } else alertCi.delete(r.id);
      if (watermark === null || r.updatedAt > watermark) watermark = r.updatedAt;
    }
    if (watermark === null) watermark = deps.now();
    const tenants: string[] = [];
    let healthChanged = 0;
    for (const [tenantId, ciIds] of affected) {
      const n = await applyCis(tenantId, [...ciIds]);
      healthChanged += n;
      if (n > 0) tenants.push(tenantId);
    }
    return { read: rows.length, expired, healthChanged, tenants };
  }

  /** One sync at a time; a wake during a pass runs one more pass after it, so no change waits for the interval. */
  async function sync(): Promise<MonitoringSyncReport> {
    if (running !== null) {
      again = true;
      return running;
    }
    const run = async (): Promise<MonitoringSyncReport> => {
      const merged: MonitoringSyncReport = { read: 0, expired: 0, healthChanged: 0, tenants: [] };
      do {
        again = false;
        const r = await pass();
        merged.read += r.read;
        merged.expired += r.expired;
        merged.healthChanged += r.healthChanged;
        merged.tenants = [...new Set([...merged.tenants, ...r.tenants])];
      } while (again);
      return merged;
    };
    running = run().finally(() => {
      running = null;
    });
    return running;
  }

  return { sync, overlay: view };
}

export type MonitoringHealth = ReturnType<typeof createMonitoringHealth>;
