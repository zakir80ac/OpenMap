// REQ-QA-001 — virtualization: vSphere, Hyper-V, Nutanix AHV and KVM clusters, hypervisor CIs on
// their physical hosts, and VMs with guest OS, addresses and MAC prefixes of their platform.
import { SYNTH_ESTATE } from '@openmap/constants';
import { DOMAIN, GUEST_OS, GUEST_OS_WEIGHTS, HYPERVISOR_COLLECTOR, HYPERVISOR_PRODUCT, type HypervisorPlatform } from '../catalog.js';
import type { Slot } from '../estate.js';
import type { Rng } from '../rng.js';
import { isoAt, MS_PER_DAY } from '../time.js';
import { allocateIp, attachIp, fqdnOf, pad, type HostRec, type HypervisorRec, type SiteWorld, type VmRec, type World } from '../world.js';

const VM_MAC_OUI: Record<HypervisorPlatform, readonly [number, number, number]> = { vmware: [0x00, 0x50, 0x56], hyperv: [0x00, 0x15, 0x5d], nutanix_ahv: [0x50, 0x6b, 0x8d], kvm_libvirt: [0x52, 0x54, 0x00] };
const MANAGER_PREFIX: Record<HypervisorPlatform, string> = { vmware: 'vcenter', hyperv: 'scvmm', nutanix_ahv: 'prism', kvm_libvirt: 'libvirt' };
const VCPU_OPTIONS = [2, 4, 4, 8, 8, 16] as const;
const MEMORY_GB_OPTIONS = [4, 8, 16, 16, 32, 64] as const;
const DISK_GB_OPTIONS = [60, 100, 200, 500] as const;
const POWERED_ON_PROBABILITY = 0.95;
const VM_AGE_DAYS_MAX = 1500;
const HARDWARE_VERSION: Record<HypervisorPlatform, string> = { vmware: 'vmx-21', hyperv: '10.0', nutanix_ahv: 'ahv-10', kvm_libvirt: 'pc-q35-8.2' };

function platformSlot(world: World, site: SiteWorld, platform: HypervisorPlatform, firstHost: HostRec): Slot {
  const manager = platform === 'kvm_libvirt' ? firstHost.fqdn : MANAGER_PREFIX[platform] + '-' + site.short + '-01.' + DOMAIN;
  return world.b.slotFor(platform + '|' + site.nodeId + '|' + manager, {
    family: platform,
    collectorId: HYPERVISOR_COLLECTOR[platform],
    nodeId: site.nodeId,
    siteCode: site.def.code,
    target: { kind: 'host', value: manager, label: HYPERVISOR_PRODUCT[platform] },
    evidenceKind: 'api_response',
  });
}

export function generateVirtualization(world: World, rng: Rng): void {
  const { b } = world;
  const totalVms = b.count(SYNTH_ESTATE.vms);
  const hypervisorHosts = world.sites.flatMap((s) => s.hosts.filter((h) => h.plan.platform !== null));
  if (hypervisorHosts.length === 0) return;
  const perHypervisor = Math.floor(totalVms / hypervisorHosts.length);
  let remainder = totalVms - perHypervisor * hypervisorHosts.length;
  let moRefSeq = 1000;
  let vmSeq = 0;

  for (const site of world.sites) {
    const clusters = new Map<number, HostRec[]>();
    for (const host of site.hosts) {
      if (host.plan.platform === null) continue;
      const list = clusters.get(host.plan.cluster) ?? [];
      list.push(host);
      clusters.set(host.plan.cluster, list);
    }
    for (const [, members] of [...clusters.entries()].sort((x, y) => x[0] - y[0])) {
      const first = members[0];
      if (!first || first.plan.platform === null || first.plan.clusterName === null) continue;
      const platform = first.plan.platform;
      const clusterName = first.plan.clusterName;
      const slot = platformSlot(world, site, platform, first);
      const clusterIdx = b.ci(
        slot,
        'vm_cluster',
        { platform, clusterId: clusterName },
        clusterName,
        { name: clusterName, platform, product: HYPERVISOR_PRODUCT[platform], hostCount: members.length, totalCpuCores: members.reduce((a, h) => a + h.plan.model.cpuSockets * h.plan.model.coresPerSocket, 0), totalMemoryGb: members.reduce((a, h) => a + h.plan.model.memoryGb, 0), haEnabled: true, drsEnabled: platform === 'vmware', evcMode: platform === 'vmware' ? 'intel-sapphirerapids' : null, site: site.def.code },
        site.def.code,
        { tags: ['virtualization', platform] },
      );
      b.rel(slot, 'located_in', clusterIdx, site.ciIdx);

      for (const host of members) {
        const moRef = platform === 'vmware' ? 'host-' + String(moRefSeq++) : platform === 'nutanix_ahv' ? rng.uuid() : host.fqdn;
        const vmCount = perHypervisor + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder--;
        const hypIdx = b.ci(
          slot,
          'hypervisor',
          { platform, hostRef: host.serial, moRef },
          host.hostname,
          { platform, product: HYPERVISOR_PRODUCT[platform], version: host.plan.os.version, build: host.plan.os.kernel, cluster: clusterName, cpuCores: host.plan.model.cpuSockets * host.plan.model.coresPerSocket, memoryGb: host.plan.model.memoryGb, vmCount, connectionState: 'connected', maintenanceMode: false, managementIp: host.ip, uptimeSeconds: rng.int(86_400, 200 * 86_400) },
          site.def.code,
          { tags: ['virtualization', platform] },
        );
        b.rel(slot, 'runs_on', hypIdx, host.idx);
        b.rel(slot, 'member_of', hypIdx, clusterIdx);
        const hyp: HypervisorRec = { idx: hypIdx, host, platform, clusterIdx, clusterName, moRef, vms: [] };
        host.hypervisor = hyp;
        site.hypervisors.push(hyp);

        for (let i = 0; i < vmCount; i++) {
          vmSeq++;
          const name = 'vm-' + site.short + '-' + pad(vmSeq, 5);
          const fqdn = fqdnOf(name);
          const os = GUEST_OS[rng.weighted(GUEST_OS_WEIGHTS)] ?? GUEST_OS[0];
          if (!os) throw new Error('no guest operating systems in catalogue');
          const instanceUuid = rng.uuid();
          const alloc = allocateIp(world, site, 'vms');
          const mac = rng.mac(VM_MAC_OUI[platform]);
          const vmIdx = b.ci(
            slot,
            'vm',
            { instanceUuid, hypervisorRef: moRef, fqdn },
            name,
            {
              name,
              hostname: name,
              fqdn,
              instanceUuid,
              platform,
              hypervisor: host.hostname,
              cluster: clusterName,
              vcpus: rng.pick(VCPU_OPTIONS),
              memoryGb: rng.pick(MEMORY_GB_OPTIONS),
              diskGb: rng.pick(DISK_GB_OPTIONS),
              guestOs: os.name + ' ' + os.version,
              guestOsFamily: os.family,
              powerState: rng.chance(POWERED_ON_PROBABILITY) ? 'poweredOn' : 'poweredOff',
              toolsStatus: platform === 'vmware' ? 'toolsOk' : null,
              hardwareVersion: HARDWARE_VERSION[platform],
              ipAddress: alloc.address,
              macAddress: mac,
              network: 'VLAN ' + alloc.subnetCidr,
              datastore: clusterName + '-ds-' + pad(rng.int(1, 6), 2),
              createdAt: isoAt(-rng.int(1, VM_AGE_DAYS_MAX) * MS_PER_DAY),
              template: false,
              site: site.def.code,
            },
            site.def.code,
            { tags: ['virtualization', platform], primary: true },
          );
          b.rel(slot, 'hosted_on', vmIdx, hypIdx);
          const ipIdx = attachIp(world, slot, vmIdx, alloc, site.def.code, { interface: os.family === 'windows' ? 'Ethernet' : 'ens192', macAddress: mac });
          const vm: VmRec = { idx: vmIdx, hypervisor: hyp, site, name, fqdn, os, ip: alloc.address, ipIdx, instanceUuid, slot, role: null };
          hyp.vms.push(vm);
          site.vms.push(vm);
        }
      }
    }
  }
}

/** Renames a VM once an application or cluster claims it; identity fqdn follows. */
export function renameVm(world: World, vm: VmRec, name: string, role: string): void {
  const ci = world.b.get(vm.idx);
  const fqdn = fqdnOf(name);
  ci.name = name;
  ci.identity['fqdn'] = fqdn;
  ci.attributes['name'] = name;
  ci.attributes['hostname'] = name;
  ci.attributes['fqdn'] = fqdn;
  ci.attributes['applicationRole'] = role;
  vm.name = name;
  vm.fqdn = fqdn;
  vm.role = role;
}
