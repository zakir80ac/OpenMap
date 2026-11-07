// REQ-CORE-012 — time helpers shared by every module: ISO rendering and the temporal predicate for
// bitemporal reads ([validFrom, validTo) contains asOf; validTo null means current).
import type { Prisma } from '@openmap/db';

export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function isoOf(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Prisma predicate selecting the CI version valid at `asOf`, or the current version when null. */
export function validAt(asOf: string | null): Prisma.CiWhereInput {
  if (asOf === null) return { validTo: null };
  const at = new Date(asOf);
  return { validFrom: { lte: at }, OR: [{ validTo: null }, { validTo: { gt: at } }] };
}

/** Same predicate for relationships. */
export function relationshipValidAt(asOf: string | null): Prisma.RelationshipWhereInput {
  if (asOf === null) return { validTo: null };
  const at = new Date(asOf);
  return { validFrom: { lte: at }, OR: [{ validTo: null }, { validTo: { gt: at } }] };
}

const ISO_DATE = 'YYYY-MM-DD';

/** The calendar date (YYYY-MM-DD, UTC) of a Postgres DATE column or an instant. */
export function isoDateOf(value: Date): string {
  return value.toISOString().slice(0, ISO_DATE.length);
}
