// REQ-CMDB-001 — CiFilter → Prisma where translation. Pure so every clause is unit-tested. The
// health clause is resolved against the graph first and arrives here as a list of candidate ids.
import { Prisma } from '@openmap/db';
import type { SortKey } from '../common/cursor.js';
import { validAt } from '../common/time.js';
import type { CiFilterInput } from './ci.schemas.js';

/** Relationship type linking a CI to the site that houses it. */
export const LOCATED_IN = 'located_in';

export function textClause(text: string): Prisma.CiWhereInput {
  const contains = { contains: text, mode: Prisma.QueryMode.insensitive } as const;
  return { OR: [{ name: contains }, { displayName: contains }, { tags: { has: text } }] };
}

export function attributeClause(key: string, value: string | number | boolean | null): Prisma.CiWhereInput {
  return { attributes: { path: [key], equals: value === null ? Prisma.JsonNull : value } };
}

/** Rows after the cursor in (name, id) order. */
export function afterClause(after: SortKey): Prisma.CiWhereInput {
  return { OR: [{ name: { gt: after.name } }, { name: after.name, id: { gt: after.id } }] };
}

export function buildCiWhere(tenantId: string, filter: CiFilterInput, healthIds: readonly string[] | null, after: SortKey | null): Prisma.CiWhereInput {
  const and: Prisma.CiWhereInput[] = [validAt(filter.asOf ?? null)];
  if (filter.types && filter.types.length > 0) and.push({ type: { in: filter.types } });
  if (filter.layers && filter.layers.length > 0) and.push({ layer: { in: filter.layers } });
  if (filter.lifecycle && filter.lifecycle.length > 0) and.push({ lifecycle: { in: filter.lifecycle } });
  if (filter.tags && filter.tags.length > 0) and.push({ tags: { hasEvery: filter.tags } });
  if (filter.siteId) and.push({ relationshipsFrom: { some: { type: LOCATED_IN, toCiId: filter.siteId, validTo: null } } });
  if (filter.text && filter.text.trim().length > 0) and.push(textClause(filter.text.trim()));
  if (filter.attributeEquals) for (const [k, v] of Object.entries(filter.attributeEquals)) and.push(attributeClause(k, v));
  if (healthIds !== null) and.push({ id: { in: [...healthIds] } });
  if (after !== null) and.push(afterClause(after));
  return { tenantId, AND: and };
}

export const CI_ORDER: Prisma.CiOrderByWithRelationInput[] = [{ name: 'asc' }, { id: 'asc' }];
