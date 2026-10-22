// REQ-QA-001 — claiming helpers: applications and Kubernetes clusters take unassigned VMs and
// bare-metal hosts from a site. Cursors per OS family keep this linear at scale 1.
import type { OsDef } from '../catalog.js';
import type { HostRec, SiteWorld, VmRec } from '../world.js';

type Family = OsDef['family'] | 'any';

const vmCursors = new WeakMap<SiteWorld, Map<Family, number>>();
const hostCursors = new WeakMap<SiteWorld, Map<Family, number>>();

function cursorMap(store: WeakMap<SiteWorld, Map<Family, number>>, site: SiteWorld): Map<Family, number> {
  let map = store.get(site);
  if (!map) {
    map = new Map();
    store.set(site, map);
  }
  return map;
}

/** First unassigned VM of the family in the site, or null when the site is exhausted. */
export function claimVm(site: SiteWorld, family: Family): VmRec | null {
  const cursors = cursorMap(vmCursors, site);
  let i = cursors.get(family) ?? 0;
  while (i < site.vms.length) {
    const vm = site.vms[i];
    i++;
    if (vm && vm.role === null && (family === 'any' || vm.os.family === family)) {
      cursors.set(family, i);
      return vm;
    }
  }
  cursors.set(family, i);
  return null;
}

/** First unassigned bare-metal host of the family in the site, or null when exhausted. */
export function claimHost(site: SiteWorld, family: Family): HostRec | null {
  const cursors = cursorMap(hostCursors, site);
  let i = cursors.get(family) ?? 0;
  while (i < site.hosts.length) {
    const host = site.hosts[i];
    i++;
    if (host && host.role === null && host.plan.platform === null && (family === 'any' || host.plan.os.family === family)) {
      cursors.set(family, i);
      return host;
    }
  }
  cursors.set(family, i);
  return null;
}
