// REQ-CMDB-001 — Prisma row → domain record mapping. Provenance is flattened in Postgres and
// re-assembled here; JSON columns are narrowed to the contract shapes.
import { ciCode, userLabelSchema, type CiType, type RelationshipType } from '@openmap/contracts';
import type { Prisma, PrismaClient } from '@openmap/db';
import { isoOf, toIso } from '../common/time.js';
import { asRecord } from '../common/validation.js';
import type { CiRecord, CiVersionRecord, Lifecycle, RelationshipRecord } from './ci.types.js';

export const CI_INCLUDE = { externalIds: true } as const;
export type CiRow = Prisma.CiGetPayload<{ include: typeof CI_INCLUDE }>;
export type RelationshipRow = Awaited<ReturnType<PrismaClient['relationship']['findUniqueOrThrow']>>;

function identityOf(json: Prisma.JsonValue): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(asRecord(json))) out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  return out;
}

/** Only scalar values survive: anything else in the column is ignored rather than handed to the client. */
function customFieldsOf(json: unknown): Record<string, string | number | boolean> {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(json as Record<string, unknown>))
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  return out;
}

export function toCiRecord(row: CiRow): CiRecord {
  const label = row.userLabel === null ? null : userLabelSchema.safeParse(row.userLabel);
  return {
    id: row.id,
    tenantId: row.tenantId,
    type: row.type as CiType,
    layer: row.layer,
    name: row.name,
    displayName: row.displayName,
    code: row.code ?? ciCode(row.layer, row.type, row.name),
    identity: identityOf(row.identity),
    attributes: asRecord(row.attributes),
    tags: row.tags,
    customFields: customFieldsOf(row.customFields),
    externalIds: row.externalIds.map((e) => ({ source: e.source, id: e.externalId })),
    lifecycle: row.lifecycle as Lifecycle,
    userLabel: label !== null && label.success ? label.data : null,
    source: {
      collectorId: row.sourceCollectorId,
      nodeId: row.sourceNodeId,
      runId: row.sourceRunId,
      confidence: row.sourceConfidence,
    },
    observedAt: isoOf(row.observedAt),
    validFrom: isoOf(row.validFrom),
    validTo: toIso(row.validTo),
    checksum: row.checksum,
  };
}

export function toRelationshipRecord(row: RelationshipRow): RelationshipRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    type: row.type as RelationshipType,
    fromCiId: row.fromCiId,
    toCiId: row.toCiId,
    attributes: asRecord(row.attributes),
    source: {
      collectorId: row.sourceCollectorId,
      nodeId: row.sourceNodeId,
      runId: row.sourceRunId,
      confidence: row.sourceConfidence,
    },
    observedAt: isoOf(row.observedAt),
    validFrom: isoOf(row.validFrom),
    validTo: toIso(row.validTo),
  };
}

export function toVersion(ci: CiRecord): CiVersionRecord {
  return {
    validFrom: ci.validFrom,
    validTo: ci.validTo,
    attributes: ci.attributes,
    lifecycle: ci.lifecycle,
    source: ci.source,
  };
}
