// REQ-CMDB-023 REQ-CMDB-025 (ADR-039) — the product lifecycle catalogue: release dates and the end of active support,
// security support and extended support per product release ("cycle"), as published by endoflife.date (bundled as a
// snapshot and optionally refreshed) or entered by a person or a vendor EoX lookup. A discovered operating system,
// hypervisor or network OS is matched to its release by the rules below; dates are never typed from memory (R-004).
import { z } from 'zod';

export const LIFECYCLE_KINDS = ['os', 'hypervisor', 'network_os', 'database', 'platform', 'hardware'] as const;
export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number];

export const LIFECYCLE_STATES = ['supported', 'ending', 'ended', 'unknown'] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/** The source label of the endoflife.date catalogue. */
export const ENDOFLIFE_SOURCE = 'endoflife.date';

const date = z.iso.date();

export const lifecycleEntrySchema = z.object({
  source: z.string().min(1),
  product: z.string().min(1),
  cycle: z.string().min(1),
  kind: z.enum(LIFECYCLE_KINDS),
  label: z.string().min(1),
  releaseDate: date.nullable(),
  /** End of active support (bug fixes); null when the publisher gives none. */
  supportEnd: date.nullable(),
  /** End of security support: the release is end of life after this date. */
  endOfSupport: date.nullable(),
  /** True when the publisher marks the release ended without a date. */
  supportEnded: z.boolean(),
  extendedSupportEnd: date.nullable(),
  latest: z.string().nullable(),
  lts: z.boolean(),
  link: z.string().nullable(),
});
export type LifecycleEntry = z.infer<typeof lifecycleEntrySchema>;

/** One release row as endoflife.date publishes it: dates are ISO dates or booleans. */
const endOfLifeRowSchema = z.object({
  cycle: z.union([z.string(), z.number()]),
  releaseLabel: z.string().optional(),
  codename: z.string().nullable().optional(),
  releaseDate: z.string().optional(),
  support: z.union([z.string(), z.boolean()]).optional(),
  eol: z.union([z.string(), z.boolean()]).optional(),
  extendedSupport: z.union([z.string(), z.boolean()]).optional(),
  latest: z.union([z.string(), z.number()]).optional(),
  lts: z.union([z.boolean(), z.string()]).optional(),
  link: z.string().nullable().optional(),
});

function isoDate(value: string | boolean | undefined): string | null {
  return typeof value === 'string' && date.safeParse(value).success ? value : null;
}

/** A catalogue entry from one endoflife.date release row, or null when the row is not one. */
export function fromEndOfLifeDate(product: string, kind: LifecycleKind, title: string, row: unknown): LifecycleEntry | null {
  const parsed = endOfLifeRowSchema.safeParse(row);
  if (!parsed.success) return null;
  const r = parsed.data;
  const cycle = String(r.cycle);
  return {
    source: ENDOFLIFE_SOURCE,
    product,
    cycle,
    kind,
    label: r.releaseLabel ?? title + ' ' + cycle,
    releaseDate: isoDate(r.releaseDate),
    supportEnd: isoDate(r.support),
    endOfSupport: isoDate(r.eol),
    supportEnded: r.eol === true,
    extendedSupportEnd: isoDate(r.extendedSupport),
    latest: r.latest === undefined ? null : String(r.latest),
    lts: r.lts === true || typeof r.lts === 'string',
    link: r.link ?? null,
  };
}

const MS_PER_DAY = 86_400_000;

/** Whole days from `now` to the end of security support, or null without a date. */
export function daysToEndOfSupport(entry: Pick<LifecycleEntry, 'endOfSupport'>, now: Date): number | null {
  return entry.endOfSupport === null ? null : Math.floor((Date.parse(entry.endOfSupport) - now.getTime()) / MS_PER_DAY);
}

/** Supported, ending inside `endingDays`, ended, or unknown when there is no entry or no date. */
export function lifecycleState(entry: Pick<LifecycleEntry, 'endOfSupport' | 'supportEnded'> | null, now: Date, endingDays: number): LifecycleState {
  if (entry === null) return 'unknown';
  if (entry.supportEnded) return 'ended';
  const days = daysToEndOfSupport(entry, now);
  if (days === null) return 'unknown';
  if (days < 0) return 'ended';
  return days <= endingDays ? 'ending' : 'supported';
}

export interface Release {
  product: string;
  cycle: string;
}

function str(attributes: Record<string, unknown>, key: string): string {
  const v = attributes[key];
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

/** The first `n` numeric parts of a version ("24.04.1" → "24.04" for 2, "9.4" → "9" for 1), or null. */
export function versionParts(version: string, n: number): string | null {
  const m = /^\D*(\d+(?:\.\d+)*)/u.exec(version);
  if (m?.[1] === undefined) return null;
  const parts = m[1].split('.');
  return parts.length < n ? null : parts.slice(0, n).join('.');
}

interface OsRule {
  /** Matches os-release ID, or the OS name or caption, lower-cased. */
  test: (id: string, name: string) => boolean;
  product: string;
  /** Numeric version parts that make the cycle. */
  parts: number;
}

const OS_RULES: readonly OsRule[] = [
  { test: (id, n) => id === 'ubuntu' || n.includes('ubuntu'), product: 'ubuntu', parts: 2 },
  { test: (id, n) => id === 'debian' || n.includes('debian'), product: 'debian', parts: 1 },
  { test: (id, n) => id === 'rhel' || n.includes('red hat enterprise linux'), product: 'rhel', parts: 1 },
  { test: (id, n) => id === 'centos' || n.startsWith('centos'), product: 'centos', parts: 1 },
  { test: (id, n) => id === 'rocky' || n.includes('rocky linux'), product: 'rocky-linux', parts: 1 },
  { test: (id, n) => id === 'almalinux' || n.includes('almalinux'), product: 'almalinux', parts: 1 },
  { test: (id, n) => id === 'ol' || n.includes('oracle linux'), product: 'oracle-linux', parts: 1 },
  { test: (id, n) => id === 'sles' || n.includes('suse linux enterprise'), product: 'sles', parts: 2 },
  { test: (id, n) => id === 'opensuse-leap' || n.includes('opensuse leap'), product: 'opensuse', parts: 2 },
  { test: (id, n) => id === 'amzn' || n.includes('amazon linux'), product: 'amazon-linux', parts: 1 },
  { test: (id, n) => id === 'fedora' || n.startsWith('fedora'), product: 'fedora', parts: 1 },
  { test: (id, n) => id === 'alpine' || n.includes('alpine linux'), product: 'alpine-linux', parts: 2 },
  { test: (_id, n) => n.includes('esxi') || n.includes('vsphere'), product: 'esxi', parts: 2 },
  { test: (id, n) => id === 'proxmox' || n.includes('proxmox'), product: 'proxmox-ve', parts: 1 },
];

/** Windows Server releases by the year (and R2) in a caption or version; cycles as endoflife.date names them. */
const WINDOWS_SERVER_CYCLES: ReadonlyArray<[RegExp, string]> = [
  [/2008 r2/u, '2008-r2-sp1'],
  [/2012 r2/u, '2012-r2'],
  [/\b2025\b/u, '2025'],
  [/\b2022\b/u, '2022'],
  [/\b2019\b/u, '2019'],
  [/\b2016\b/u, '2016'],
  [/\b2012\b/u, '2012'],
  [/\b2008\b/u, '2008-sp2'],
];

function windowsServer(text: string): Release | null {
  for (const [pattern, cycle] of WINDOWS_SERVER_CYCLES) if (pattern.test(text)) return { product: 'windows-server', cycle };
  return null;
}

/**
 * The release an operating-system CI runs, from what its collector reports: os-release `id` and `versionId` (SSH),
 * `caption` (WMI), or `name` and `version` (other sources). Null when the OS is not one the catalogue covers.
 */
export function osRelease(attributes: Record<string, unknown>): Release | null {
  const id = str(attributes, 'id').toLowerCase();
  const name = (str(attributes, 'caption') || str(attributes, 'name')).toLowerCase();
  const version = str(attributes, 'versionId') || str(attributes, 'version');
  if (name.includes('windows server')) return windowsServer(name + ' ' + version);
  for (const rule of OS_RULES) {
    if (!rule.test(id, name)) continue;
    const cycle = versionParts(version, rule.parts);
    return cycle === null ? null : { product: rule.product, cycle };
  }
  return null;
}

/** Network and load-balancer operating systems by the name collectors report, with the parts that make the cycle. */
const NETWORK_OS: Readonly<Record<string, { product: string; parts: number }>> = {
  'ios-xe': { product: 'cisco-ios-xe', parts: 2 },
  'pan-os': { product: 'panos', parts: 2 },
  fortios: { product: 'fortios', parts: 2 },
  tmos: { product: 'big-ip', parts: 2 },
};

/**
 * The platform release of a network device, load balancer, hypervisor or cluster: its network OS (`osName` and
 * `osVersion`) or its virtualisation product (`product` and `version`). Null when the catalogue does not cover it.
 */
export function platformRelease(type: string, attributes: Record<string, unknown>): Release | null {
  if (type === 'network_device' || type === 'load_balancer' || type === 'firewall_rule') {
    const os = NETWORK_OS[str(attributes, 'osName').toLowerCase()];
    if (os === undefined) return null;
    const cycle = versionParts(str(attributes, 'osVersion'), os.parts);
    return cycle === null ? null : { product: os.product, cycle };
  }
  if (type === 'hypervisor' || type === 'vm_cluster') {
    const product = str(attributes, 'product').toLowerCase();
    const version = str(attributes, 'version') || product;
    if (product.includes('vsphere') || product.includes('esxi')) {
      const cycle = versionParts(versionParts(version, 2) ?? product.replace(/^\D+/u, ''), 2);
      return cycle === null ? null : { product: 'esxi', cycle };
    }
    if (product.includes('nutanix aos')) {
      const cycle = versionParts(product.replace(/^\D+/u, ''), 2);
      return cycle === null ? null : { product: 'nutanix-aos', cycle };
    }
    if (product.includes('hyper-v')) return windowsServer(product);
  }
  return null;
}
