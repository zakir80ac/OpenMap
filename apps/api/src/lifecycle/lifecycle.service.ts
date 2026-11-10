// REQ-CMDB-023 REQ-CMDB-025 (ADR-039) — lifecycle over the catalogue: the releases the tenant's operating systems,
// hypervisors and network operating systems run (matched by the contract's release rules), with how many CIs run each,
// the end of active, security and extended support and whether it is supported, ending or ended; patch currency for
// operating systems; hardware end of sale and support from the asset register grouped by model; the catalogue's
// sources; and the optional, tenant-enabled sync that refreshes the catalogue from LIFECYCLE_CATALOGUE_URL.
import { Inject, Injectable } from '@nestjs/common';
import { LIFECYCLE, TIME } from '@openmap/constants';
import {
  ENDOFLIFE_SOURCE,
  daysToEndOfSupport,
  endOfLifeSchema,
  lifecycleState,
  osRelease,
  platformRelease,
  type CiType,
  type LifecycleKind,
  type LifecycleState,
  type Release,
} from '@openmap/contracts';
import { Prisma, fetchEndOfLifeCatalogue, loadLifecycleSnapshot } from '@openmap/db';
import { AuditService } from '../audit/audit.service.js';
import { ENV, type Env } from '../config/env.module.js';
import { PrismaService } from '../db/prisma.service.js';
import { IntegrationsService } from '../integrations/integrations.service.js';

export interface CatalogueEntryView {
  source: string;
  product: string;
  cycle: string;
  label: string;
  releaseDate: string | null;
  supportEnd: string | null;
  endOfSupport: string | null;
  supportEnded: boolean;
  extendedSupportEnd: string | null;
  latest: string | null;
  lts: boolean;
  link: string | null;
}

export interface ReleaseRowView {
  key: string;
  kind: LifecycleKind;
  product: string | null;
  cycle: string | null;
  label: string;
  count: number;
  versions: string[];
  entry: CatalogueEntryView | null;
  state: LifecycleState;
  daysLeft: number | null;
  /** Operating systems only: CIs last patched longer ago than LIFECYCLE.patchStaleDays. */
  patchBehind: number | null;
  oldestPatchAt: string | null;
  ciIds: string[];
  /** Lower-cased CI names (and reported OS names), for the text filter. */
  names: string[];
}

export interface ReleasePageView {
  rows: ReleaseRowView[];
  supported: number;
  ending: number;
  ended: number;
  unknown: number;
}

export interface HardwareRowView {
  key: string;
  ciType: string;
  manufacturer: string | null;
  model: string | null;
  count: number;
  /** Assets of this model with an end of support recorded. */
  dated: number;
  endOfSale: string | null;
  endOfSupport: string | null;
  sources: string[];
  state: LifecycleState;
  daysLeft: number | null;
}

export interface CatalogueSourceView {
  source: string;
  products: number;
  releases: number;
  fetchedAt: Date;
}

export interface CatalogueView {
  sources: CatalogueSourceView[];
  url: string;
  syncAllowed: boolean;
}

export interface ReleaseFilter {
  kind: LifecycleKind | null;
  state: LifecycleState | null;
  text: string | null;
}

interface CiRow {
  id: string;
  type: string;
  displayName: string;
  attributes: Prisma.JsonValue;
}

interface EntryRow {
  source: string;
  product: string;
  cycle: string;
  label: string;
  releaseDate: Date | null;
  supportEnd: Date | null;
  endOfSupport: Date | null;
  supportEnded: boolean;
  extendedSupportEnd: Date | null;
  latest: string | null;
  lts: boolean;
  link: string | null;
}

const OS_TYPES = ['operating_system'];
/** Worst first: what needs action leads; releases without a date before supported ones, hardware without a date last. */
const RELEASE_ORDER: readonly LifecycleState[] = ['ended', 'ending', 'unknown', 'supported'];
const HARDWARE_ORDER: readonly LifecycleState[] = ['ended', 'ending', 'supported', 'unknown'];
const PLATFORM_TYPES = ['hypervisor', 'vm_cluster', 'network_device', 'load_balancer'];
/** Hardware the register tracks end of sale and support for. */
const HARDWARE_TYPES: CiType[] = ['host', 'chassis', 'blade', 'network_device', 'load_balancer', 'storage_array', 'fc_switch', 'pdu', 'ups', 'cooling_unit'];

function isoDay(d: Date | null): string | null {
  return d === null ? null : d.toISOString().slice(0, TIME.isoDateLength);
}

function attrs(row: CiRow): Record<string, unknown> {
  return typeof row.attributes === 'object' && row.attributes !== null && !Array.isArray(row.attributes) ? (row.attributes as Record<string, unknown>) : {};
}

function text(a: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = a[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return '';
}

function entryView(e: EntryRow): CatalogueEntryView {
  return {
    source: e.source,
    product: e.product,
    cycle: e.cycle,
    label: e.label,
    releaseDate: isoDay(e.releaseDate),
    supportEnd: isoDay(e.supportEnd),
    endOfSupport: isoDay(e.endOfSupport),
    supportEnded: e.supportEnded,
    extendedSupportEnd: isoDay(e.extendedSupportEnd),
    latest: e.latest,
    lts: e.lts,
    link: e.link,
  };
}

/** The kind of a matched release, from the catalogue's product list. */
function kindOf(product: string, fallback: LifecycleKind): LifecycleKind {
  return LIFECYCLE.products.find((p) => p.product === product)?.kind ?? fallback;
}

@Injectable()
export class LifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Catalogue entries by product and cycle; endoflife.date first, then the other sources. */
  private async entries(): Promise<Map<string, EntryRow>> {
    const rows = await this.prisma.client.lifecycleEntry.findMany({ orderBy: [{ fetchedAt: 'asc' }] });
    const out = new Map<string, EntryRow>();
    for (const r of rows) {
      const key = r.product + '|' + r.cycle;
      if (!out.has(key) || r.source === ENDOFLIFE_SOURCE) out.set(key, r);
    }
    return out;
  }

  async releases(tenantId: string, filter: ReleaseFilter, now: Date = new Date()): Promise<ReleasePageView> {
    const types = filter.kind === null ? [...OS_TYPES, ...PLATFORM_TYPES] : filter.kind === 'os' ? OS_TYPES : PLATFORM_TYPES;
    const [cis, entries] = await Promise.all([
      // Ordered, so a release lists its instances the same way every time (not in the order rows happen to be stored).
      this.prisma.client.ci.findMany({
        where: { tenantId, validTo: null, type: { in: types as never } },
        select: { id: true, type: true, displayName: true, attributes: true },
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      }),
      this.entries(),
    ]);
    const groups = new Map<string, { kind: LifecycleKind; release: Release | null; label: string; ids: string[]; names: string[]; versions: Set<string>; patched: string[] }>();
    for (const ci of cis as CiRow[]) {
      const a = attrs(ci);
      const isOs = ci.type === 'operating_system';
      const release = isOs ? osRelease(a) : platformRelease(ci.type, a);
      const kind: LifecycleKind = release !== null ? kindOf(release.product, isOs ? 'os' : 'hypervisor') : isOs ? 'os' : ci.type === 'hypervisor' || ci.type === 'vm_cluster' ? 'hypervisor' : 'network_os';
      if (filter.kind !== null && kind !== filter.kind) continue;
      const name = isOs ? text(a, 'caption', 'name', 'id') : text(a, 'osName', 'product');
      const version = isOs ? text(a, 'version', 'versionId', 'build') : text(a, 'osVersion', 'version');
      const key = release !== null ? release.product + '|' + release.cycle : 'unmatched|' + kind + '|' + name.toLowerCase();
      const label = release !== null ? (entries.get(key)?.label ?? name + ' ' + release.cycle) : name || ci.type;
      const g = groups.get(key) ?? { kind, release, label, ids: [], names: [], versions: new Set<string>(), patched: [] };
      g.ids.push(ci.id);
      g.names.push((ci.displayName + ' ' + name).toLowerCase());
      if (version !== '') g.versions.add(version);
      const patched = text(a, 'lastPatchedAt');
      if (isOs && patched !== '') g.patched.push(patched);
      groups.set(key, g);
    }
    const staleBefore = now.getTime() - LIFECYCLE.patchStaleDays * TIME.msPerDay;
    const needle = filter.text?.trim().toLowerCase() ?? '';
    let rows: ReleaseRowView[] = [...groups.entries()].map(([key, g]) => {
      const entry = g.release === null ? null : (entries.get(key) ?? null);
      const view = entry === null ? null : entryView(entry);
      const isOs = g.kind === 'os';
      return {
        key,
        kind: g.kind,
        product: g.release?.product ?? null,
        cycle: g.release?.cycle ?? null,
        label: g.label,
        count: g.ids.length,
        versions: [...g.versions].sort(),
        entry: view,
        state: lifecycleState(view, now, LIFECYCLE.endingDays),
        daysLeft: view === null ? null : daysToEndOfSupport(view, now),
        patchBehind: isOs ? g.patched.filter((p) => Date.parse(p) < staleBefore).length : null,
        oldestPatchAt: isOs && g.patched.length > 0 ? [...g.patched].sort()[0] ?? null : null,
        ciIds: g.ids,
        names: g.names,
      };
    });
    if (needle !== '')
      rows = rows.filter((r) => r.label.toLowerCase().includes(needle) || (r.product ?? '').includes(needle) || r.versions.some((v) => v.toLowerCase().includes(needle)) || r.names.some((n) => n.includes(needle)));
    const counts = { supported: 0, ending: 0, ended: 0, unknown: 0 };
    for (const r of rows) counts[r.state] += r.count;
    if (filter.state !== null) rows = rows.filter((r) => r.state === filter.state);
    const rank = (state: LifecycleState): number => RELEASE_ORDER.indexOf(state);
    rows.sort((a, b) => rank(a.state) - rank(b.state) || (a.daysLeft ?? Number.MAX_SAFE_INTEGER) - (b.daysLeft ?? Number.MAX_SAFE_INTEGER) || b.count - a.count || a.label.localeCompare(b.label));
    return { rows, ...counts };
  }

  /** Hardware end of sale and support by model, from the asset register's end-of-life records. */
  async hardware(tenantId: string, state: LifecycleState | null, needle: string | null, now: Date = new Date()): Promise<HardwareRowView[]> {
    const assets = await this.prisma.client.assetRecord.findMany({
      where: { tenantId, ciType: { in: HARDWARE_TYPES } },
      select: { ciType: true, manufacturer: true, model: true, endOfLife: true },
    });
    const groups = new Map<string, HardwareRowView & { saleDates: string[]; supportDates: string[] }>();
    for (const a of assets) {
      const ciType = a.ciType ?? 'unknown';
      const key = ciType + '|' + (a.manufacturer ?? '') + '|' + (a.model ?? '');
      const g = groups.get(key) ?? { key, ciType, manufacturer: a.manufacturer, model: a.model, count: 0, dated: 0, sources: [] as string[], state: 'unknown' as LifecycleState, daysLeft: null as number | null, saleDates: [] as string[], supportDates: [] as string[], endOfSale: null as string | null, endOfSupport: null as string | null };
      g.count += 1;
      const eol = endOfLifeSchema.safeParse(a.endOfLife);
      if (eol.success) {
        if (eol.data.endOfSupport !== null) {
          g.dated += 1;
          g.supportDates.push(eol.data.endOfSupport);
        }
        if (eol.data.endOfSale !== null) g.saleDates.push(eol.data.endOfSale);
        if (!g.sources.includes(eol.data.source)) g.sources.push(eol.data.source);
      }
      groups.set(key, g);
    }
    const lower = needle?.trim().toLowerCase() ?? '';
    const rows = [...groups.values()].map(({ saleDates, supportDates, ...g }) => {
      // The earliest date recorded for the model governs: one unit out of support is a model out of support.
      const endOfSupport = supportDates.sort()[0] ?? null;
      const entry = { endOfSupport, supportEnded: false };
      return { ...g, endOfSale: saleDates.sort()[0] ?? null, endOfSupport, state: lifecycleState(endOfSupport === null ? null : entry, now, LIFECYCLE.endingDays), daysLeft: daysToEndOfSupport(entry, now) };
    });
    const rank = (state: LifecycleState): number => HARDWARE_ORDER.indexOf(state);
    return rows
      .filter((r) => (state === null || r.state === state) && (lower === '' || (r.manufacturer ?? '').toLowerCase().includes(lower) || (r.model ?? '').toLowerCase().includes(lower)))
      .sort((a, b) => rank(a.state) - rank(b.state) || (a.daysLeft ?? Number.MAX_SAFE_INTEGER) - (b.daysLeft ?? Number.MAX_SAFE_INTEGER) || b.count - a.count);
  }

  async catalogue(tenantId: string): Promise<CatalogueView> {
    const grouped = await this.prisma.client.lifecycleEntry.groupBy({ by: ['source'], _count: { _all: true }, _max: { fetchedAt: true } });
    const products = await this.prisma.client.lifecycleEntry.groupBy({ by: ['source', 'product'] });
    let syncAllowed = true;
    try {
      await this.integrations.assertOutboundAllowed(tenantId);
    } catch {
      syncAllowed = false;
    }
    return {
      sources: grouped.map((g) => ({ source: g.source, releases: g._count._all, products: products.filter((p) => p.source === g.source).length, fetchedAt: g._max.fetchedAt ?? new Date(0) })),
      url: this.env.LIFECYCLE_CATALOGUE_URL,
      syncAllowed,
    };
  }

  /** Refreshes the catalogue from LIFECYCLE_CATALOGUE_URL; refused unless the deployment and tenant allow outbound calls. */
  async sync(tenantId: string, actor: { username: string; requestId: string }): Promise<{ catalogue: CatalogueView; failed: string[] }> {
    await this.integrations.assertOutboundAllowed(tenantId);
    const report = await fetchEndOfLifeCatalogue(this.env.LIFECYCLE_CATALOGUE_URL);
    const loaded = await loadLifecycleSnapshot(this.prisma.client, report.snapshot);
    await this.audit.record({ tenantId, username: actor.username, requestId: actor.requestId }, 'lifecycle.synced', 'lifecycle_catalogue', ENDOFLIFE_SOURCE, {
      releases: loaded,
      products: Object.keys(report.snapshot.products).length,
      failed: report.failed.map((f) => f.product),
    });
    return { catalogue: await this.catalogue(tenantId), failed: report.failed.map((f) => f.product + ': ' + f.error) };
  }
}
