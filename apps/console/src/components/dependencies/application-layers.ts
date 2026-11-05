// REQ-DEP-004 (ADR-031) — the layered application map's arrangement: for every component, the placements reachable
// from it through the placement chain (a VM it runs on, the hypervisor under that VM), grouped by layer in
// CI_LAYERS order so the screen can draw one row per layer under the tier columns, and the dependencies of each
// component. A plain module so the view test and the view share one reading.
import { CI_LAYERS, type CiLayer } from '@openmap/contracts';
import type { ApplicationDependency, ApplicationMap, Placement } from '@/lib/application-map-queries';

/** Placements reachable from each component, walking parent links, nearest hop first, each CI once per component. */
export function placementsByComponent(map: ApplicationMap): Map<string, Placement[]> {
  const byParent = new Map<string, Placement[]>();
  for (const p of map.placements) {
    const list = byParent.get(p.parentId) ?? [];
    list.push(p);
    byParent.set(p.parentId, list);
  }
  const out = new Map<string, Placement[]>();
  for (const tier of map.tiers)
    for (const component of tier.components) {
      const seen = new Set<string>();
      const reached: Placement[] = [];
      let frontier = [component.ci.id];
      while (frontier.length > 0) {
        const next: string[] = [];
        for (const parent of frontier)
          for (const p of byParent.get(parent) ?? []) {
            if (seen.has(p.ci.id)) continue;
            seen.add(p.ci.id);
            reached.push(p);
            next.push(p.ci.id);
          }
        frontier = next;
      }
      out.set(component.ci.id, reached.sort((a, b) => a.hop - b.hop || a.ci.displayName.localeCompare(b.ci.displayName)));
    }
  return out;
}

/** The layers the placements occupy, in CI_LAYERS order. */
export function placementLayers(map: ApplicationMap): CiLayer[] {
  const present = new Set(map.placements.map((p) => p.ci.layer));
  return CI_LAYERS.filter((layer) => present.has(layer));
}

/** The dependencies a component takes part in, outbound before inbound. */
export function dependenciesOf(map: ApplicationMap, componentId: string): ApplicationDependency[] {
  return map.dependencies.filter((d) => d.from.id === componentId || d.to.id === componentId);
}

/** Counts per direction for the summary line. */
export function dependencyCounts(map: ApplicationMap): Record<ApplicationDependency['direction'], number> {
  const counts = { internal: 0, outbound: 0, inbound: 0 };
  for (const d of map.dependencies) counts[d.direction] += 1;
  return counts;
}
