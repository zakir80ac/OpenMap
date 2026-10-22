// REQ-QA-001 — host plan: decides, before any rack exists, how many hosts each site gets, which are
// hypervisors (grouped into clusters with a platform) and which bare-metal OS the rest run.
import { SYNTH_ESTATE } from '@openmap/constants';
import { BARE_METAL_OS, BARE_METAL_OS_WEIGHTS, HOST_MODELS, HYPERVISOR_OS, HYPERVISOR_PLATFORMS, HYPERVISOR_PLATFORM_WEIGHTS } from '../catalog.js';
import type { Rng } from '../rng.js';
import type { HostPlan, World } from '../world.js';

/** Average consolidation ratio; drives the hypervisor count from the VM count. */
export const VMS_PER_HYPERVISOR = 12;
const CLUSTER_MIN = 8;
const CLUSTER_MAX = 16;
/** Hypervisors favour 2U models (more memory and local NVMe) at this ratio. */
const HYPERVISOR_2U_WEIGHT = 3;

export function planHosts(world: World, rng: Rng): HostPlan[] {
  const { b } = world;
  const totalHosts = b.count(SYNTH_ESTATE.hosts);
  const totalVms = b.count(SYNTH_ESTATE.vms);
  const totalHypervisors = Math.max(1, Math.ceil(totalVms / VMS_PER_HYPERVISOR));
  const computeSites = world.sites.filter((s) => s.def.hostShare > 0);
  const primary = computeSites[0];
  if (!primary) throw new Error('no compute sites defined');

  const hostsPerSite = new Map(computeSites.map((s) => [s.def.code, Math.floor(totalHosts * s.def.hostShare)] as const));
  const hypervisorsPerSite = new Map(computeSites.map((s) => [s.def.code, Math.floor(totalHypervisors * s.def.hostShare)] as const));
  const assignedHosts = [...hostsPerSite.values()].reduce((a, n) => a + n, 0);
  const assignedHyp = [...hypervisorsPerSite.values()].reduce((a, n) => a + n, 0);
  hostsPerSite.set(primary.def.code, (hostsPerSite.get(primary.def.code) ?? 0) + (totalHosts - assignedHosts));
  hypervisorsPerSite.set(primary.def.code, (hypervisorsPerSite.get(primary.def.code) ?? 0) + (totalHypervisors - assignedHyp));

  const plans: HostPlan[] = [];
  let clusterSeq = 0;
  const twoU = HOST_MODELS.filter((m) => m.heightU === 2);
  const oneU = HOST_MODELS.filter((m) => m.heightU === 1);

  for (const site of computeSites) {
    const hosts = hostsPerSite.get(site.def.code) ?? 0;
    const hypervisors = Math.min(hosts, hypervisorsPerSite.get(site.def.code) ?? 0);
    let remaining = hypervisors;
    while (remaining > 0) {
      let size = Math.min(remaining, rng.int(CLUSTER_MIN, CLUSTER_MAX));
      if (remaining - size > 0 && remaining - size < CLUSTER_MIN) size = remaining;
      const platform = HYPERVISOR_PLATFORMS[rng.weighted(HYPERVISOR_PLATFORM_WEIGHTS)] ?? 'vmware';
      const cluster = clusterSeq++;
      for (let i = 0; i < size; i++) {
        const model = rng.weighted([HYPERVISOR_2U_WEIGHT, 1]) === 0 ? rng.pick(twoU) : rng.pick(oneU);
        plans.push({ site, model, platform, cluster, os: HYPERVISOR_OS[platform], rack: null, uPosition: 0 });
      }
      remaining -= size;
    }
    for (let i = hypervisors; i < hosts; i++) {
      const os = BARE_METAL_OS[rng.weighted(BARE_METAL_OS_WEIGHTS)] ?? BARE_METAL_OS[0];
      if (!os) throw new Error('no bare-metal operating systems in catalogue');
      plans.push({ site, model: rng.pick(HOST_MODELS), platform: null, cluster: -1, os, rack: null, uPosition: 0 });
    }
  }
  return plans;
}
