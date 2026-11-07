// REQ-QA-001 — commercial and risk records: vendors, support contracts (some expired), cost
// centres, warranty coverage of hardware, software licences and CVEs attached to software versions.
import { createHash } from 'node:crypto';
import {
  CURRENCY,
  CVE_SEVERITIES,
  CVE_SEVERITY_WEIGHTS,
  COST_CENTRES,
  SOFTWARE,
  VENDORS,
  type VendorDef,
} from '../catalog.js';
import type { Slot } from '../estate.js';
import type { Rng } from '../rng.js';
import { dateAt, isoAt, MS_PER_DAY } from '../time.js';
import { ensureSoftware, fqdnOf, pad, samSlot, siteOf, softwareRefOf, type World } from '../world.js';

const VULNERABILITIES_BASE = 320;
const LICENCES_PER_SOFTWARE: readonly [number, number] = [1, 2];
const CONTRACT_EXPIRED_PROBABILITY = 0.25;
const LICENCE_EXPIRED_PROBABILITY = 0.15;
const CONTRACT_TERM_DAYS: readonly number[] = [365, 1095, 1825];
const DAYS_PER_YEAR = 365;
const CVE_CURRENT_YEAR = 2026;
const CVE_PREVIOUS_YEAR_PROBABILITY = 0.15;
const EXPLOITED_PROBABILITY = 0.1;
const RESPONSE_MINUTES: Record<VendorDef['supportLevel'], number> = {
  basic: 1440,
  next_business_day: 480,
  four_hour: 240,
  mission_critical: 60,
};
const HARDWARE_VENDORS = new Set([
  'Dell Technologies',
  'Hewlett Packard Enterprise',
  'Lenovo',
  'Cisco Systems',
  'Arista Networks',
  'Juniper Networks',
  'Palo Alto Networks',
  'Fortinet',
  'F5',
  'NetApp',
  'Pure Storage',
  'Brocade',
  'Nutanix',
  'Schneider Electric',
  'Vertiv',
]);
const CONTRACT_PORTALS: Record<string, string> = {
  'Dell Technologies': 'Dell TechDirect',
  'Hewlett Packard Enterprise': 'HPE Support Center',
  'Cisco Systems': 'Cisco SNTC',
  Lenovo: 'Lenovo Premier',
  'Palo Alto Networks': 'PAN Customer Support Portal',
};
const CVSS_VECTORS = [
  'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
  'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:L/A:N',
  'CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H',
  'CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:L/A:N',
] as const;
const CVSS_BY_SEVERITY: Record<string, readonly [number, number]> = {
  critical: [9.0, 10.0],
  high: [7.0, 8.9],
  medium: [4.0, 6.9],
  low: [0.1, 3.9],
};

function coverageSlot(world: World): Slot {
  const site = siteOf(world, 'RYD');
  return world.b.slotFor('sam-coverage', {
    family: 'agent',
    collectorId: 'agent-sam',
    nodeId: site.nodeId,
    siteCode: site.def.code,
    target: { kind: 'host', value: fqdnOf('sam-' + site.short + '-01'), label: 'asset coverage' },
    evidenceKind: 'agent_report',
  });
}

function vulnSlot(world: World): Slot {
  const site = siteOf(world, 'RYD');
  return world.b.slotFor('vuln', {
    family: 'vulnerability_feed',
    collectorId: 'vulnerability-feed',
    nodeId: site.nodeId,
    siteCode: site.def.code,
    target: { kind: 'host', value: fqdnOf('nvd-mirror-ryd-01'), label: 'offline NVD mirror' },
    evidenceKind: 'api_response',
  });
}

function bumpVersion(version: string): string {
  const m = /^(.*?)(\d+)([^\d]*)$/.exec(version);
  if (!m) return version + '.1';
  return (m[1] ?? '') + String(Number(m[2] ?? '0') + 1) + (m[3] ?? '');
}

export function generateCommercial(world: World, rng: Rng): void {
  const { b } = world;
  const ryd = siteOf(world, 'RYD');
  const slot = samSlot(world);

  const costCentreIdx: number[] = [];
  COST_CENTRES.forEach((cc, i) => {
    costCentreIdx.push(
      b.ci(
        slot,
        'cost_centre',
        { code: cc.code },
        cc.name,
        {
          code: cc.code,
          name: cc.name,
          owner: i < 3 ? cc.name.replace(' Technology', '') : 'Group Technology',
          currency: CURRENCY,
          annualBudget: rng.int(2_000_000, 80_000_000),
        },
        ryd.def.code,
        { tags: ['commercial'] },
      ),
    );
  });

  const vendorIdx = new Map<string, number>();
  const contractsByVendor = new Map<string, number[]>();
  for (const vendor of VENDORS) {
    const vIdx = b.ci(
      slot,
      'vendor',
      { name: vendor.name },
      vendor.name,
      {
        supportLevel: vendor.supportLevel,
        supportPortal: CONTRACT_PORTALS[vendor.name] ?? vendor.name + ' support portal',
        accountManager: rng.pick([
          'Faisal Al-Harbi',
          'Noura Al-Qahtani',
          'Omar Haddad',
          'Lina Saleh',
          'Khalid Mansour',
        ]),
        category: HARDWARE_VENDORS.has(vendor.name) ? 'hardware' : 'software',
        supplierId: 'SUP-' + rng.alnum(6),
      },
      ryd.def.code,
      { tags: ['commercial', 'vendor'] },
    );
    vendorIdx.set(vendor.name, vIdx);
    const contracts = HARDWARE_VENDORS.has(vendor.name) ? 2 : 1;
    const list: number[] = [];
    for (let c = 0; c < contracts; c++) {
      const term = rng.pick(CONTRACT_TERM_DAYS);
      const expired = rng.chance(CONTRACT_EXPIRED_PROBABILITY);
      const start = expired ? -term - rng.int(10, 400) : -rng.int(10, term - 30);
      const contractNumber =
        vendor.name
          .replace(/[^A-Za-z]/g, '')
          .slice(0, 4)
          .toUpperCase() +
        '-' +
        rng.alnum(8);
      const title =
        vendor.name +
        ' ' +
        (c === 0 ? 'premium support' : 'extended warranty') +
        ' ' +
        String(CVE_CURRENT_YEAR - Math.ceil(-start / DAYS_PER_YEAR));
      const cc = costCentreIdx[rng.int(0, costCentreIdx.length - 1)];
      const cIdx = b.ci(
        slot,
        'contract',
        { vendorRef: vendor.name, contractNumber },
        title,
        {
          contractNumber,
          title,
          level: vendor.supportLevel,
          responseMinutes: RESPONSE_MINUTES[vendor.supportLevel],
          startsAt: dateAt(start),
          endsAt: dateAt(start + term),
          expired,
          autoRenews: rng.chance(0.5),
          annualCost: rng.int(50_000, 4_000_000),
          currency: CURRENCY,
          externalSystem: CONTRACT_PORTALS[vendor.name] ?? null,
          coveredAssets: 0,
        },
        ryd.def.code,
        { tags: ['commercial', 'contract', expired ? 'expired' : 'active'] },
      );
      b.rel(slot, 'supported_by', cIdx, vIdx);
      if (cc !== undefined) b.rel(slot, 'billed_to', cIdx, cc);
      list.push(cIdx);
    }
    contractsByVendor.set(vendor.name, list);
  }

  // Warranty and support coverage for hosts, network devices and arrays, rotated across the vendor's contracts.
  const rotation = new Map<string, number>();
  const cover = (ciIdx: number, manufacturer: string): void => {
    const vIdx = vendorIdx.get(manufacturer);
    const contracts = contractsByVendor.get(manufacturer) ?? [];
    if (vIdx === undefined) return;
    const cslot = coverageSlot(world);
    b.countPrimary(cslot);
    b.rel(cslot, 'supported_by', ciIdx, vIdx);
    const n = rotation.get(manufacturer) ?? 0;
    rotation.set(manufacturer, n + 1);
    const contract = contracts[n % Math.max(1, contracts.length)];
    if (contract !== undefined) {
      b.rel(cslot, 'covered_by', ciIdx, contract, { coverage: 'hardware_support' });
      const ci = b.get(contract);
      ci.attributes['coveredAssets'] = Number(ci.attributes['coveredAssets'] ?? 0) + 1;
    }
  };
  for (const site of world.sites) {
    for (const host of site.hosts) cover(host.idx, host.plan.model.manufacturer);
    for (const device of site.devices) cover(device.idx, device.model.manufacturer);
    for (const arrayIdx of site.storageArrays)
      cover(arrayIdx, String(b.get(arrayIdx).attributes['manufacturer']));
  }

  // Licences for every licensed software title.
  for (const def of SOFTWARE) {
    if (!def.licensed) continue;
    const softwareIdx = ensureSoftware(world, def);
    const vendorContracts = contractsByVendor.get(def.vendor) ?? [];
    const n = rng.int(LICENCES_PER_SOFTWARE[0], LICENCES_PER_SOFTWARE[1]);
    for (let i = 0; i < n; i++) {
      const key =
        def.vendor.slice(0, 3).toUpperCase() + '-' + rng.alnum(5) + '-' + rng.alnum(5) + '-' + rng.alnum(5);
      const digest = createHash('sha256').update(key).digest('hex');
      const expired = rng.chance(LICENCE_EXPIRED_PROBABILITY);
      const metric =
        def.category === 'database'
          ? def.vendor === 'Oracle'
            ? 'processor'
            : 'core'
          : def.category === 'os'
            ? 'socket'
            : 'seat';
      const entitlement = rng.int(16, 4000);
      const consumed = Math.round(entitlement * rng.float(0.4, 1.15));
      const lIdx = b.ci(
        slot,
        'licence',
        { licenceKeyDigest: digest, softwareRef: softwareRefOf(def) },
        def.name + ' ' + def.version + ' licence ' + pad(i + 1, 2),
        {
          vendor: def.vendor,
          software: def.name,
          version: def.version,
          metric,
          entitlement,
          consumed,
          overDeployed: consumed > entitlement,
          licenceType: def.category === 'os' || def.vendor === 'Oracle' ? 'subscription' : 'perpetual',
          subscriptionStart: dateAt(expired ? -rng.int(400, 700) : -rng.int(1, 335)),
          expiresAt: dateAt(expired ? -rng.int(1, 300) : rng.int(30, 1000)),
          expired,
          poNumber: 'PO-' + rng.alnum(7),
          currency: CURRENCY,
          annualCost: rng.int(20_000, 3_000_000),
        },
        ryd.def.code,
        { tags: ['licence', expired ? 'expired' : 'active'] },
      );
      b.rel(slot, 'licensed_by', softwareIdx, lIdx);
      const contract = vendorContracts[i % Math.max(1, vendorContracts.length)];
      if (contract !== undefined)
        b.rel(slot, 'covered_by', lIdx, contract, { coverage: 'software_maintenance' });
    }
  }

  // Vulnerabilities from the offline feed, attached to software versions.
  const vslot = vulnSlot(world);
  const total = b.count(VULNERABILITIES_BASE);
  let seq = rng.int(1000, 3000);
  const components = [
    'buffer overflow',
    'authentication bypass',
    'privilege escalation',
    'remote code execution',
    'information disclosure',
    'denial of service',
    'path traversal',
    'deserialization',
  ];
  for (let i = 0; i < total; i++) {
    seq += rng.int(1, 9);
    const year = rng.chance(CVE_PREVIOUS_YEAR_PROBABILITY) ? CVE_CURRENT_YEAR - 1 : CVE_CURRENT_YEAR;
    const cveId = 'CVE-' + String(year) + '-' + pad(seq, 4);
    const severity = CVE_SEVERITIES[rng.weighted(CVE_SEVERITY_WEIGHTS)] ?? 'medium';
    const range = CVSS_BY_SEVERITY[severity] ?? [4.0, 6.9];
    const affected = new Set<number>();
    const k = rng.int(1, 3);
    for (let j = 0; j < k; j++) affected.add(rng.int(0, SOFTWARE.length - 1));
    const first = SOFTWARE[[...affected][0] ?? 0];
    const title = (first?.name ?? 'software') + ' ' + rng.pick(components);
    const published = -rng.int(1, year === CVE_CURRENT_YEAR ? 280 : 650);
    const vIdx = b.ci(
      vslot,
      'vulnerability',
      { cveId },
      cveId,
      {
        cveId,
        title,
        severity,
        cvssScore: Number(rng.float(range[0], range[1]).toFixed(1)),
        cvssVector: rng.pick(CVSS_VECTORS),
        publishedAt: isoAt(published * MS_PER_DAY),
        lastModifiedAt: isoAt((published + rng.int(0, 30)) * MS_PER_DAY),
        exploitedInWild: rng.chance(EXPLOITED_PROBABILITY),
        cisaKev: rng.chance(EXPLOITED_PROBABILITY / 2),
        affectedCount: affected.size,
        source: 'NVD',
        patchAvailable: rng.chance(0.85),
      },
      ryd.def.code,
      { tags: ['vulnerability', severity], primary: true },
    );
    for (const s of affected) {
      const def = SOFTWARE[s];
      if (!def) continue;
      const softwareIdx = ensureSoftware(world, def);
      b.rel(vslot, 'affected_by', softwareIdx, vIdx, {
        fixedIn: bumpVersion(def.version),
        affectedVersions: '<= ' + def.version,
      });
    }
  }
}
