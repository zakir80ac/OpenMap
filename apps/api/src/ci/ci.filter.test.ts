// T-015 REQ-CMDB-001 — CiFilter → Prisma where translation.
import { describe, expect, it } from 'vitest';
import { Prisma } from '@openmap/db';
import { afterClause, attributeClause, buildCiWhere, LOCATED_IN, textClause } from './ci.filter.js';

const tenantId = '9b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e';
const siteId = '0f6d4c0b-9d7e-4a1f-8b4c-5d6e9b2c6a7e';

describe('buildCiWhere', () => {
  it('scopes by tenant and current versions when the filter is empty', () => {
    expect(buildCiWhere(tenantId, {}, null, null)).toEqual({ tenantId, AND: [{ validTo: null }] });
  });
  it('translates asOf into the bitemporal predicate', () => {
    const asOf = '2026-10-22T09:00:00.000Z';
    const where = buildCiWhere(tenantId, { asOf }, null, null);
    expect(where.AND).toEqual([{ validFrom: { lte: new Date(asOf) }, OR: [{ validTo: null }, { validTo: { gt: new Date(asOf) } }] }]);
  });
  it('translates enumerations, tags and site membership', () => {
    const where = buildCiWhere(tenantId, { types: ['host', 'vm'], layers: ['hardware'], lifecycle: ['managed'], tags: ['prod', 'pci'], siteId }, null, null);
    expect(where.AND).toEqual([
      { validTo: null },
      { type: { in: ['host', 'vm'] } },
      { layer: { in: ['hardware'] } },
      { lifecycle: { in: ['managed'] } },
      { tags: { hasEvery: ['prod', 'pci'] } },
      { relationshipsFrom: { some: { type: LOCATED_IN, toCiId: siteId, validTo: null } } },
    ]);
  });
  it('ignores empty lists and blank text', () => {
    expect(buildCiWhere(tenantId, { types: [], layers: [], tags: [], text: '   ' }, null, null).AND).toEqual([{ validTo: null }]);
  });
  it('searches name, display name and tags case-insensitively', () => {
    expect(textClause('ledger')).toEqual({
      OR: [{ name: { contains: 'ledger', mode: Prisma.QueryMode.insensitive } }, { displayName: { contains: 'ledger', mode: Prisma.QueryMode.insensitive } }, { tags: { has: 'ledger' } }],
    });
    const where = buildCiWhere(tenantId, { text: ' pg-core ' }, null, null);
    expect(where.AND).toContainEqual(textClause('pg-core'));
  });
  it('matches attributes by JSON path, mapping null to JsonNull', () => {
    expect(attributeClause('vendor', 'Dell')).toEqual({ attributes: { path: ['vendor'], equals: 'Dell' } });
    expect(attributeClause('cpuCount', 64)).toEqual({ attributes: { path: ['cpuCount'], equals: 64 } });
    expect(attributeClause('rack', null)).toEqual({ attributes: { path: ['rack'], equals: Prisma.JsonNull } });
    const where = buildCiWhere(tenantId, { attributeEquals: { vendor: 'Dell', internetFacing: true } }, null, null);
    expect(where.AND).toContainEqual({ attributes: { path: ['vendor'], equals: 'Dell' } });
    expect(where.AND).toContainEqual({ attributes: { path: ['internetFacing'], equals: true } });
  });
  it('restricts to graph-resolved ids when a health filter is present, even when none match', () => {
    expect(buildCiWhere(tenantId, { health: ['down'] }, ['a', 'b'], null).AND).toContainEqual({ id: { in: ['a', 'b'] } });
    expect(buildCiWhere(tenantId, { health: ['down'] }, [], null).AND).toContainEqual({ id: { in: [] } });
  });
  it('pages after a (name, id) cursor', () => {
    const after = { name: 'm', id: 'id-5' };
    expect(afterClause(after)).toEqual({ OR: [{ name: { gt: 'm' } }, { name: 'm', id: { gt: 'id-5' } }] });
    const where = buildCiWhere(tenantId, {}, null, after);
    expect(where.AND?.at(-1)).toEqual(afterClause(after));
  });
});
