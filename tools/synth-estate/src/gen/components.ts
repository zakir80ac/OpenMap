// REQ-CMDB-014 (ADR-037) — the parts inside a synthetic server, as the SSH, WMI and Redfish collectors report them on
// the host's `components` attribute: one CPU per socket, DIMMs filling the configured memory, mirrored boot SSDs plus
// data drives, the onboard and mezzanine NICs, two FC HBAs on hypervisors and two power supplies. Each host draws from
// its own stream seeded by its serial number, never the estate stream, so adding parts reshuffles no other value.
import type { Component } from '@openmap/contracts';
import type { HostModelDef } from '../catalog.js';
import { Rng } from '../rng.js';

const GIB = 1024 ** 3;
const DIMM_GB_OPTIONS = [32, 64] as const;
const LARGE_MEMORY_GB = 1024;
const LARGE_DIMM_GB = 128;
const DIMM_SLOTS_PER_SOCKET = 16;
const BOOT_DRIVES = 2;
const DATA_DRIVES_MAX = 6;
const BOOT_SSD_GB = 480;
const DATA_SSD_GB_OPTIONS = [1920, 3840, 7680] as const;
const NIC_SPEED_MBPS = 25_000;
const HBA_PER_HYPERVISOR = 2;
const PSU_COUNT = 2;
const PSU_WATTS_OPTIONS = [1100, 1400, 1600] as const;
const MEMORY_VENDORS = [
  { manufacturer: 'Samsung', partPrefix: 'M321R' },
  { manufacturer: 'SK Hynix', partPrefix: 'HMCG94' },
  { manufacturer: 'Micron', partPrefix: 'MTC40F' },
] as const;
const SSD_MODELS = ['Samsung PM893', 'Micron 5400 PRO', 'Kioxia CD6-R'] as const;
const NIC_MODELS = ['Broadcom BCM57414', 'Intel E810-XXVDA2', 'NVIDIA ConnectX-6 Lx'] as const;
const HBA_MODELS = ['Emulex LPe35002', 'Marvell QLogic QLE2772'] as const;
const CPU_THREADS_PER_CORE = 2;
const DIMM_SPEED_MTS = 4800;
const WWPN_PREFIX = '0x10000090fa';
const WWPN_SUFFIX_DIGITS = 6;

export interface HostParts {
  model: HostModelDef;
  cpuModel: string;
  serial: string;
  hypervisor: boolean;
}

/** The part list of one generated server. */
export function hostComponents(host: HostParts): Component[] {
  const r = new Rng('components:' + host.serial);
  const cpuVendor = host.cpuModel.startsWith('AMD') ? 'AMD' : 'Intel';
  const out: Component[] = [];
  for (let s = 0; s < host.model.cpuSockets; s++)
    out.push({
      kind: 'cpu',
      slot: 'CPU' + String(s + 1),
      model: host.cpuModel,
      manufacturer: cpuVendor,
      details: { cores: host.model.coresPerSocket, threads: host.model.coresPerSocket * CPU_THREADS_PER_CORE },
    });

  const dimmGb = host.model.memoryGb >= LARGE_MEMORY_GB ? LARGE_DIMM_GB : r.pick(DIMM_GB_OPTIONS);
  const dimms = Math.min(Math.ceil(host.model.memoryGb / dimmGb), host.model.cpuSockets * DIMM_SLOTS_PER_SOCKET);
  const memory = r.pick(MEMORY_VENDORS);
  for (let d = 0; d < dimms; d++) {
    const socket = d % host.model.cpuSockets;
    const slot = Math.floor(d / host.model.cpuSockets);
    out.push({
      kind: 'memory',
      slot: 'CPU' + String(socket + 1) + ' DIMM ' + String(slot + 1),
      manufacturer: memory.manufacturer,
      partNumber: memory.partPrefix + String(dimmGb) + r.alnum(4),
      serialNumber: r.alnum(8, '0123456789ABCDEF'),
      capacityBytes: dimmGb * GIB,
      details: { type: 'DDR5', speedMts: DIMM_SPEED_MTS },
    });
  }

  const dataDrives = r.int(0, DATA_DRIVES_MAX);
  for (let d = 0; d < BOOT_DRIVES + dataDrives; d++) {
    const boot = d < BOOT_DRIVES;
    out.push({
      kind: 'disk',
      slot: 'Bay ' + String(d + 1),
      model: r.pick(SSD_MODELS),
      serialNumber: 'S' + r.alnum(11),
      capacityBytes: (boot ? BOOT_SSD_GB : r.pick(DATA_SSD_GB_OPTIONS)) * GIB,
      details: { media: 'ssd', transport: boot ? 'SATA' : 'NVMe', role: boot ? 'boot' : 'data' },
    });
  }

  const nicModel = r.pick(NIC_MODELS);
  for (let n = 0; n < (host.hypervisor ? 4 : 2); n++)
    out.push({ kind: 'nic', slot: 'NIC.Slot.' + String(Math.floor(n / 2) + 1) + '-' + String((n % 2) + 1), model: nicModel, serialNumber: r.alnum(10), details: { speedMbps: NIC_SPEED_MBPS } });

  if (host.hypervisor) {
    const hbaModel = r.pick(HBA_MODELS);
    for (let h = 0; h < HBA_PER_HYPERVISOR; h++)
      out.push({
        kind: 'hba',
        slot: 'host' + String(h + 1),
        model: hbaModel,
        serialNumber: r.alnum(10),
        details: { wwpn: WWPN_PREFIX + r.alnum(WWPN_SUFFIX_DIGITS, '0123456789abcdef'), speed: '32 Gbit' },
      });
  }

  const watts = r.pick(PSU_WATTS_OPTIONS);
  for (let p = 0; p < PSU_COUNT; p++)
    out.push({ kind: 'psu', slot: 'PSU' + String(p + 1), manufacturer: host.model.manufacturer, serialNumber: r.alnum(12), details: { capacityWatts: watts } });
  return out;
}
