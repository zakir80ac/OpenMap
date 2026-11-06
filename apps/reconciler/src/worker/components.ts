// REQ-CMDB-014 (ADR-037) — mirrors the part lists collectors observed into `ci_components`. An observation without a
// list leaves the CI's parts alone (its collector does not see parts); one with a list is the full set: every part
// upserted by kind and slot, the parts no longer reported closed with `removedAt`, and any other parent still holding
// the same serial number closed too (the part moved). A CI whose stored parts changed raises
// `openmap.component.changed`; a first part list is not a change. Array-based statements per batch, like the CI writes.
import { componentKey, diffComponents, normalizeComponents, type Component, type EventEnvelope } from '@openmap/contracts';
import { Prisma, type PrismaClient } from '@openmap/db';
import { envelope } from '../core/events.js';
import type { ObservedComponents } from '../core/reconcile.js';

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

interface StoredPart {
  id: string;
  ciId: string;
  kind: Component['kind'];
  slot: string;
  model: string | null;
  manufacturer: string | null;
  serialNumber: string | null;
  partNumber: string | null;
  capacityBytes: number | null;
  firmware: string | null;
  details: Record<string, string | number | boolean>;
}

function asComponent(row: StoredPart): Component {
  const out: Component = { kind: row.kind, slot: row.slot };
  if (row.model !== null) out.model = row.model;
  if (row.manufacturer !== null) out.manufacturer = row.manufacturer;
  if (row.serialNumber !== null) out.serialNumber = row.serialNumber;
  if (row.partNumber !== null) out.partNumber = row.partNumber;
  if (row.capacityBytes !== null) out.capacityBytes = row.capacityBytes;
  if (row.firmware !== null) out.firmware = row.firmware;
  if (Object.keys(row.details).length > 0) out.details = row.details;
  return out;
}

export interface ComponentSync {
  upserted: number;
  removed: number;
  events: EventEnvelope[];
}

/** Brings `ci_components` in line with the observed part lists. */
export async function syncComponents(tx: Tx, observed: readonly ObservedComponents[], now: Date = new Date()): Promise<ComponentSync> {
  if (observed.length === 0) return { upserted: 0, removed: 0, events: [] };
  // One list per CI: when a result observes the same CI twice, the last observation is the full set.
  const latest = new Map<string, ObservedComponents>();
  for (const o of observed) latest.set(o.ciId, o);
  const lists = [...latest.values()];
  const stored = await tx.$queryRaw<StoredPart[]>(Prisma.sql`
    SELECT id, "ciId", kind, slot, model, manufacturer, "serialNumber", "partNumber", "capacityBytes", firmware, details
    FROM ci_components WHERE "ciId" = ANY(${lists.map((o) => o.ciId)}::uuid[]) AND "removedAt" IS NULL`);
  const byCi = new Map<string, StoredPart[]>();
  for (const row of stored) byCi.set(row.ciId, [...(byCi.get(row.ciId) ?? []), row]);

  const rows: Array<{ tenantId: string; ciId: string; part: Component }> = [];
  const removedIds: string[] = [];
  const events: EventEnvelope[] = [];
  for (const o of lists) {
    const parts = normalizeComponents(o.components);
    const before = byCi.get(o.ciId) ?? [];
    const diff = diffComponents(before.map(asComponent), parts);
    for (const part of parts) rows.push({ tenantId: o.tenantId, ciId: o.ciId, part });
    const gone = new Set(diff.removed.map(componentKey));
    for (const row of before) if (gone.has(componentKey(row))) removedIds.push(row.id);
    const changed = diff.added.length + diff.removed.length + diff.replaced.length > 0;
    // A CI reporting parts for the first time (a new CI, or a collector that just started seeing parts) is not a change.
    if (changed && o.existed && before.length > 0) events.push(envelope(o.tenantId, 'openmap.component.changed', o.ciId, { ciId: o.ciId, ...diff }));
  }

  if (removedIds.length > 0)
    await tx.$executeRaw(Prisma.sql`UPDATE ci_components SET "removedAt" = ${now} WHERE id = ANY(${removedIds}::uuid[])`);
  if (rows.length > 0) {
    // A serial number reported here closes the part on any other parent that still holds it: the part moved.
    const serials = rows.filter((r) => r.part.serialNumber !== undefined);
    if (serials.length > 0)
      await tx.$executeRaw(Prisma.sql`
        UPDATE ci_components c SET "removedAt" = ${now}
        FROM unnest(${serials.map((r) => r.tenantId)}::uuid[], ${serials.map((r) => r.ciId)}::uuid[], ${serials.map((r) => r.part.serialNumber ?? '')}::text[]) AS m(tenant_id, ci_id, serial)
        WHERE c."tenantId" = m.tenant_id AND c."serialNumber" = m.serial AND c."ciId" <> m.ci_id AND c."removedAt" IS NULL`);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO ci_components ("tenantId", "ciId", kind, slot, model, manufacturer, "serialNumber", "partNumber", "capacityBytes", firmware, details, "firstSeenAt", "lastSeenAt")
      SELECT u.tenant_id, u.ci_id, u.kind, u.slot, u.model, u.manufacturer, u.serial, u.part_number, u.capacity, u.firmware, u.details::jsonb, ${now}, ${now}
      FROM unnest(
        ${rows.map((r) => r.tenantId)}::uuid[], ${rows.map((r) => r.ciId)}::uuid[], ${rows.map((r) => r.part.kind)}::text[], ${rows.map((r) => r.part.slot)}::text[],
        ${rows.map((r) => r.part.model ?? null)}::text[], ${rows.map((r) => r.part.manufacturer ?? null)}::text[], ${rows.map((r) => r.part.serialNumber ?? null)}::text[],
        ${rows.map((r) => r.part.partNumber ?? null)}::text[], ${rows.map((r) => r.part.capacityBytes ?? null)}::float8[], ${rows.map((r) => r.part.firmware ?? null)}::text[],
        ${rows.map((r) => JSON.stringify(r.part.details ?? {}))}::text[]
      ) AS u(tenant_id, ci_id, kind, slot, model, manufacturer, serial, part_number, capacity, firmware, details)
      ON CONFLICT ("ciId", kind, slot) DO UPDATE SET
        model = EXCLUDED.model, manufacturer = EXCLUDED.manufacturer, "partNumber" = EXCLUDED."partNumber",
        "capacityBytes" = EXCLUDED."capacityBytes", firmware = EXCLUDED.firmware, details = EXCLUDED.details, "lastSeenAt" = EXCLUDED."lastSeenAt",
        "firstSeenAt" = CASE WHEN ci_components."removedAt" IS NOT NULL OR ci_components."serialNumber" IS DISTINCT FROM EXCLUDED."serialNumber"
          THEN EXCLUDED."firstSeenAt" ELSE ci_components."firstSeenAt" END,
        "serialNumber" = EXCLUDED."serialNumber", "removedAt" = NULL`);
  }
  return { upserted: rows.length, removed: removedIds.length, events };
}
