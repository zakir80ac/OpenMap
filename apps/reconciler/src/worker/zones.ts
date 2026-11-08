// REQ-IPAM-003 — a full zone transfer (AXFR) is a complete snapshot of the zone: every record the zone still holds is
// in it. So after a result carrying a transferred zone lands, the zone's current dns_record CIs that the transfer no
// longer contains are retired, with the relationships that touch them, through the same events the API emits. This is
// what makes the DNS sync bidirectional in the CMDB: a record deleted on the server (or deleted from OpenMap and
// applied there) leaves the CMDB at the next transfer, and a changed record replaces the old one.
import { type Ci, type CollectorResult, type EventEnvelope } from '@openmap/contracts';
import { Prisma, type PrismaClient } from '@openmap/db';
import { withSpan } from '@openmap/telemetry';
import { envelope } from '../core/events.js';
import { identityKeyOf, rowToCi, rowToRelationship } from './lookup.js';
import { insertOutboxBatch } from './persist.js';

/** The zone attribute the DNS collector sets on a complete transfer (apps/collectors/internal/dnszone). */
const COMPLETE_TRANSFER = 'axfr';
const ACTOR = 'zone-transfer';

/** Retires the records of every fully transferred zone in the result that the transfer no longer holds. */
export async function retireMissingZoneRecords(prisma: PrismaClient, result: CollectorResult): Promise<number> {
  const zones = result.cis.filter((c) => c.type === 'dns_zone' && c.attributes['transfer'] === COMPLETE_TRANSFER).map((c) => c.identity['name']).filter((n): n is string => typeof n === 'string' && n !== '');
  if (zones.length === 0) return 0;
  return withSpan('openmap-reconciler', 'zones.retire_missing', { 'openmap.tenant': result.tenantId, 'dns.zones': zones.length }, async () => {
    let retired = 0;
    for (const zone of zones) {
      const seen = new Set(result.cis.filter((c) => c.type === 'dns_record' && c.identity['zoneRef'] === zone).map((c) => identityKeyOf('dns_record', c.identity)));
      const stale = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id::text AS id FROM cis
        WHERE "tenantId" = ${result.tenantId}::uuid AND type = 'dns_record' AND "validTo" IS NULL AND identity->>'zoneRef' = ${zone}
          AND NOT ("identityKey" = ANY(${[...seen]}::text[]))`);
      if (stale.length === 0) continue;
      const ids = stale.map((s) => s.id);
      const validTo = new Date();
      const at = validTo.toISOString();
      await prisma.$transaction(async (tx) => {
        const rows = await tx.ci.findMany({ where: { id: { in: ids } } });
        const rels = await tx.relationship.findMany({ where: { tenantId: result.tenantId, validTo: null, OR: [{ fromCiId: { in: ids } }, { toCiId: { in: ids } }] } });
        await tx.ci.updateMany({ where: { id: { in: ids } }, data: { validTo } });
        if (rels.length > 0) await tx.relationship.updateMany({ where: { id: { in: rels.map((r) => r.id) } }, data: { validTo } });
        const events: EventEnvelope[] = [
          ...rows.map((r) => {
            const ci: Ci = { ...rowToCi(r), validTo: at };
            return envelope(result.tenantId, 'openmap.ci.retired', ci.id, { ci, by: ACTOR, zone });
          }),
          ...rels.map((r) => {
            const relationship = { ...rowToRelationship(r), validTo: at };
            return envelope(result.tenantId, 'openmap.relationship.retired', r.id, { relationship, relationshipId: r.id, validTo: at, by: ACTOR });
          }),
        ];
        await insertOutboxBatch(tx, events);
      });
      retired += ids.length;
    }
    return retired;
  });
}
