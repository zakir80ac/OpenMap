// REQ-CMDB-023 REQ-CMDB-025 (ADR-039) — the product lifecycle catalogue store. `fetchEndOfLifeCatalogue` reads the
// LIFECYCLE products from an endoflife.date-compatible API (the snapshot command, and the API's tenant-enabled sync);
// `loadLifecycleSnapshot` upserts a snapshot's releases into `lifecycle_entries`. The bundled snapshot ships in
// packages/db/lifecycle so an air-gapped install has the catalogue without any outbound call.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LIFECYCLE } from '@openmap/constants';
import { fromEndOfLifeDate, type LifecycleEntry, type LifecycleKind } from '@openmap/contracts';
import { Prisma, type PrismaClient } from '@prisma/client';

/** The snapshot bundled with each release, beside the compiled package (packages/db/lifecycle). */
export const LIFECYCLE_SNAPSHOT_PATH = fileURLToPath(new URL('../lifecycle/' + LIFECYCLE.snapshotFile, import.meta.url));

export interface LifecycleProductSnapshot {
  kind: LifecycleKind;
  title: string;
  /** Release rows exactly as the publisher returned them. */
  releases: unknown[];
}

export interface LifecycleSnapshot {
  source: string;
  baseUrl: string;
  fetchedAt: string;
  products: Record<string, LifecycleProductSnapshot>;
}

export interface FetchReport {
  snapshot: LifecycleSnapshot;
  failed: Array<{ product: string; error: string }>;
}

/** Fetches every catalogue product; a product that fails is reported and left out, never invented. */
export async function fetchEndOfLifeCatalogue(baseUrl: string, fetchImpl: typeof fetch = fetch, now: Date = new Date()): Promise<FetchReport> {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  const products: Record<string, LifecycleProductSnapshot> = {};
  const failed: FetchReport['failed'] = [];
  const queue = [...LIFECYCLE.products];
  const worker = async (): Promise<void> => {
    for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
      try {
        const res = await fetchImpl(new URL(p.product + '.json', base), { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error('HTTP ' + String(res.status));
        const body: unknown = await res.json();
        if (!Array.isArray(body)) throw new Error('not a release list');
        products[p.product] = { kind: p.kind, title: p.title, releases: body };
      } catch (err) {
        failed.push({ product: p.product, error: err instanceof Error ? err.message : String(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: LIFECYCLE.fetchConcurrency }, worker));
  const ordered = Object.fromEntries(Object.keys(products).sort().map((k) => [k, products[k] as LifecycleProductSnapshot]));
  return { snapshot: { source: 'endoflife.date', baseUrl, fetchedAt: now.toISOString(), products: ordered }, failed };
}

/** The entries a snapshot describes, normalised by the contract. */
export function snapshotEntries(snapshot: LifecycleSnapshot): LifecycleEntry[] {
  const out: LifecycleEntry[] = [];
  for (const [product, p] of Object.entries(snapshot.products))
    for (const row of p.releases) {
      const entry = fromEndOfLifeDate(product, p.kind, p.title, row);
      if (entry !== null) out.push(entry);
    }
  return out;
}

export function readLifecycleSnapshot(path: string): LifecycleSnapshot {
  return JSON.parse(readFileSync(path, 'utf8')) as LifecycleSnapshot;
}

function day(value: string | null): Date | null {
  return value === null ? null : new Date(value + 'T00:00:00.000Z');
}

/** Upserts a snapshot's entries in one statement; returns how many releases it holds. */
export async function loadLifecycleSnapshot(prisma: Pick<PrismaClient, '$executeRaw'>, snapshot: LifecycleSnapshot): Promise<number> {
  const entries = snapshotEntries(snapshot);
  if (entries.length === 0) return 0;
  const fetchedAt = new Date(snapshot.fetchedAt);
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO lifecycle_entries (source, product, cycle, kind, label, "releaseDate", "supportEnd", "endOfSupport", "supportEnded", "extendedSupportEnd", latest, lts, link, "fetchedAt")
    SELECT u.source, u.product, u.cycle, u.kind, u.label, u.release_date, u.support_end, u.end_of_support, u.support_ended, u.extended_end, u.latest, u.lts, u.link, ${fetchedAt}
    FROM unnest(
      ${entries.map((e) => e.source)}::text[], ${entries.map((e) => e.product)}::text[], ${entries.map((e) => e.cycle)}::text[], ${entries.map((e) => e.kind)}::text[],
      ${entries.map((e) => e.label)}::text[], ${entries.map((e) => day(e.releaseDate))}::date[], ${entries.map((e) => day(e.supportEnd))}::date[],
      ${entries.map((e) => day(e.endOfSupport))}::date[], ${entries.map((e) => e.supportEnded)}::boolean[], ${entries.map((e) => day(e.extendedSupportEnd))}::date[],
      ${entries.map((e) => e.latest)}::text[], ${entries.map((e) => e.lts)}::boolean[], ${entries.map((e) => e.link)}::text[]
    ) AS u(source, product, cycle, kind, label, release_date, support_end, end_of_support, support_ended, extended_end, latest, lts, link)
    ON CONFLICT (source, product, cycle) DO UPDATE SET
      kind = EXCLUDED.kind, label = EXCLUDED.label, "releaseDate" = EXCLUDED."releaseDate", "supportEnd" = EXCLUDED."supportEnd",
      "endOfSupport" = EXCLUDED."endOfSupport", "supportEnded" = EXCLUDED."supportEnded", "extendedSupportEnd" = EXCLUDED."extendedSupportEnd",
      latest = EXCLUDED.latest, lts = EXCLUDED.lts, link = EXCLUDED.link, "fetchedAt" = EXCLUDED."fetchedAt"
    WHERE lifecycle_entries."fetchedAt" <= EXCLUDED."fetchedAt"`);
  return entries.length;
}
