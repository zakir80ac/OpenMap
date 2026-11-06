// T-193 REQ-CMDB-014 — the part sync against the real Postgres (ADR-037): a first part list stores every part without an
// event, even on a CI that already existed; a later sweep upserts by kind and slot, closes a part it no longer reports, records a replaced disk and raises
// one openmap.component.changed; the same serial reported by another host closes it on the first (the part moved); the
// same CI twice in one batch keeps the last list.
import { randomUUID } from 'node:crypto';
import { createPrismaClient } from '@openmap/db';
import type { Ci, Component } from '@openmap/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncComponents } from './components.js';

const prisma = createPrismaClient();
const tenantId = randomUUID();
const organizationId = randomUUID();
const now = new Date().toISOString();
const GIB = 1024 ** 3;

function host(name: string): Ci {
  const attributes: Record<string, unknown> = { hostname: name };
  return {
    id: randomUUID(),
    tenantId,
    type: 'host',
    identity: { fqdn: name },
    name,
    displayName: name,
    code: 'HW-' + name.toUpperCase(),
    layer: 'hardware',
    lifecycle: 'managed',
    attributes,
    tags: [],
    source: { collectorId: 'test', nodeId: 'test', runId: 'test', confidence: 0.9 },
    observedAt: now,
    validFrom: now,
    validTo: null,
    checksum: 'c'.repeat(64),
  } as Ci;
}

async function store(cis: readonly Ci[]): Promise<void> {
  await prisma.ci.createMany({
    data: cis.map((c) => ({
      id: c.id, tenantId, type: c.type, identity: c.identity, identityKey: c.name, name: c.name, displayName: c.displayName, code: c.code,
      layer: c.layer, lifecycle: c.lifecycle, attributes: c.attributes as object, tags: c.tags, sourceCollectorId: 'test', sourceNodeId: 'test',
      sourceRunId: 'test', sourceConfidence: 0.9, observedAt: new Date(now), validFrom: new Date(now), checksum: c.checksum,
    })),
  });
}

const seen = (ci: Ci, components: Component[], existed: boolean) => ({ ciId: ci.id, tenantId, existed, components });
const parts = (ciId: string) => prisma.ciComponent.findMany({ where: { ciId }, orderBy: [{ kind: 'asc' }, { slot: 'asc' }] });

describe('component sync (integration)', () => {
  beforeAll(async () => {
    await prisma.organization.create({ data: { id: organizationId, name: 'Component sync org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: false } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'component-sync', slug: 'component-sync-' + tenantId.slice(0, 8) } });
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  it('stores, updates, closes, replaces and moves parts', async () => {
    const first: Component[] = [
      { kind: 'cpu', slot: '0', model: 'Xeon Gold 6338', details: { cores: 32 } },
      { kind: 'disk', slot: 'sda', model: 'PM893', serialNumber: 'S-1', capacityBytes: 960 * GIB },
      { kind: 'disk', slot: 'sdb', model: 'PM893', serialNumber: 'S-2', capacityBytes: 960 * GIB },
    ];
    const a = host('a');
    await store([a]);
    // The same CI twice in one result: the last list wins.
    // An existing CI reporting parts for the first time: stored, no event.
    const s1 = await syncComponents(prisma, [seen(a, [first[0]!], true), seen(a, first, true)]);
    expect(s1.upserted).toBe(3);
    expect(s1.events).toHaveLength(0);
    expect((await parts(a.id)).map((p) => p.slot)).toEqual(['0', 'sda', 'sdb']);

    // Next sweep: sda replaced (new serial), sdb gone, a NIC added.
    const later = new Date(Date.now() + 60_000);
    const next: Component[] = [first[0]!, { ...first[1]!, serialNumber: 'S-9' }, { kind: 'nic', slot: 'eno1', details: { mac: '00:1b:21:00:00:01' } }];
    const s2 = await syncComponents(prisma, [seen(a, next, true)], later);
    expect(s2.removed).toBe(1);
    expect(s2.events).toHaveLength(1);
    const data = s2.events[0]!.data as { added: Component[]; removed: Component[]; replaced: Array<{ before: Component; after: Component }> };
    expect(data.added.map((c) => c.slot)).toEqual(['eno1']);
    expect(data.removed.map((c) => c.slot)).toEqual(['sdb']);
    expect(data.replaced.map((r) => r.after.serialNumber)).toEqual(['S-9']);
    const rows = await parts(a.id);
    const sda = rows.find((p) => p.slot === 'sda');
    expect(sda?.serialNumber).toBe('S-9');
    expect(sda?.firstSeenAt.getTime()).toBe(later.getTime());
    expect(rows.find((p) => p.slot === 'sdb')?.removedAt?.getTime()).toBe(later.getTime());
    expect(rows.find((p) => p.slot === '0')?.firstSeenAt.getTime()).toBeLessThan(later.getTime());

    // Disk S-9 turns up in host b: closed on a.
    const b = host('b');
    const bParts: Component[] = [{ kind: 'disk', slot: 'sdc', serialNumber: 'S-9', capacityBytes: 960 * GIB }];
    await store([b]);
    await syncComponents(prisma, [seen(b, bParts, false)]);
    expect((await parts(a.id)).find((p) => p.slot === 'sda')?.removedAt).not.toBeNull();
    expect((await parts(b.id))[0]?.removedAt).toBeNull();

    // Unchanged sweep: no event, nothing closed.
    const s3 = await syncComponents(prisma, [seen(b, bParts, true)]);
    expect(s3.events).toHaveLength(0);
    expect(s3.removed).toBe(0);
  });
});
