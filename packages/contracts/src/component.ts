// REQ-CMDB-014 (ADR-037) — device parts and components. A collector reports the parts it can see inside a host, VM,
// blade, network device or storage array on the observed CI's optional `components` list (attributes stay flat): one
// entry per CPU socket, memory module, disk, NIC, HBA, GPU, power supply or controller, keyed by kind and slot. An
// observation without the list leaves the stored parts alone; one with it (even empty) is the full set. The reconciler
// mirrors the list into
// `ci_components` (one row per part, kept after it disappears so a replaced disk or a moved DIMM stays traceable) and
// raises `openmap.component.changed` when a later sweep sees parts added or removed. Parts are not CIs: a 40k-host estate
// would otherwise carry several hundred thousand extra graph nodes that no dependency ever points at.
import { z } from 'zod';

export const COMPONENT_KINDS = ['cpu', 'memory', 'disk', 'nic', 'hba', 'gpu', 'psu', 'controller'] as const;
export const componentKindSchema = z.enum(COMPONENT_KINDS);
export type ComponentKind = z.infer<typeof componentKindSchema>;

/** Detail values a part may carry beyond the common fields (cores, threads, speed, MAC, WWPN, media type…). */
export const componentDetailSchema = z.record(z.string().min(1), z.union([z.string(), z.number(), z.boolean()]));

export const componentSchema = z.object({
  kind: componentKindSchema,
  /** Where the part sits, unique per kind within its parent: socket, DIMM slot, device name, port, bay. */
  slot: z.string().min(1),
  model: z.string().min(1).optional(),
  manufacturer: z.string().min(1).optional(),
  serialNumber: z.string().min(1).optional(),
  partNumber: z.string().min(1).optional(),
  /** Bytes for memory and disks; absent for parts without a capacity. */
  capacityBytes: z.number().nonnegative().optional(),
  firmware: z.string().min(1).optional(),
  details: componentDetailSchema.optional(),
});
export type Component = z.infer<typeof componentSchema>;

/** A part list with one entry per kind and slot, the last one winning. */
export function normalizeComponents(list: readonly Component[]): Component[] {
  const bySlot = new Map<string, Component>();
  for (const c of list) bySlot.set(componentKey(c), c);
  return [...bySlot.values()];
}

/** Kind and slot: a part's identity within its parent. */
export function componentKey(c: Pick<Component, 'kind' | 'slot'>): string {
  return c.kind + '\u0000' + c.slot;
}

export interface ComponentChanges<T extends Pick<Component, 'kind' | 'slot'>> {
  added: T[];
  removed: T[];
  /** Present before and after with a different serial number: the part in that slot was replaced. */
  replaced: Array<{ before: T; after: T }>;
}

/** What changed between the parts a parent had and the parts a sweep now reports. */
export function diffComponents<T extends Pick<Component, 'kind' | 'slot' | 'serialNumber'>>(
  before: readonly T[],
  after: readonly T[],
): ComponentChanges<T> {
  const old = new Map(before.map((c) => [componentKey(c), c]));
  const now = new Map(after.map((c) => [componentKey(c), c]));
  const added: T[] = [];
  const removed: T[] = [];
  const replaced: Array<{ before: T; after: T }> = [];
  for (const [key, c] of now) {
    const prior = old.get(key);
    if (prior === undefined) added.push(c);
    else if ((prior.serialNumber ?? '') !== (c.serialNumber ?? '') && prior.serialNumber !== undefined) replaced.push({ before: prior, after: c });
  }
  for (const [key, c] of old) if (!now.has(key)) removed.push(c);
  return { added, removed, replaced };
}

export interface ComponentTotals {
  count: Record<ComponentKind, number>;
  memoryBytes: number;
  diskBytes: number;
}

/** Counts per kind and the memory and disk capacity a part list adds up to. */
export function componentTotals(components: readonly Pick<Component, 'kind' | 'capacityBytes'>[]): ComponentTotals {
  const count = Object.fromEntries(COMPONENT_KINDS.map((k) => [k, 0])) as Record<ComponentKind, number>;
  let memoryBytes = 0;
  let diskBytes = 0;
  for (const c of components) {
    count[c.kind] += 1;
    if (c.kind === 'memory') memoryBytes += c.capacityBytes ?? 0;
    if (c.kind === 'disk') diskBytes += c.capacityBytes ?? 0;
  }
  return { count, memoryBytes, diskBytes };
}

/** Data of `openmap.component.changed`: the parts a sweep found added, removed or replaced in one parent CI. */
export const componentChangedSchema = z.object({
  ciId: z.string().uuid(),
  added: z.array(componentSchema),
  removed: z.array(componentSchema),
  replaced: z.array(z.object({ before: componentSchema, after: componentSchema })),
});
export type ComponentChanged = z.infer<typeof componentChangedSchema>;
