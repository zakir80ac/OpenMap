// REQ-AI-007 (ADR-028) — what the tenant's CMDB actually carries: the attribute keys present per CI type and the
// values of the low-cardinality keys that work as scopes (site, platform, cluster, role, manufacturer). Discovered
// from the data and cached per tenant, so the assistant never guesses a key the collectors do not write and a
// scope word such as "VMware" or "RYD" resolves to the attribute that holds it.
import { Injectable } from '@nestjs/common';
import { ASSISTANT } from '@openmap/constants';
import type { CiType } from '@openmap/contracts';
import { ATTRIBUTE_FAMILIES, normalise, type AttributeFamilyId } from '@openmap/assistant';
import { Prisma } from '@openmap/db';
import { PrismaService } from '../db/prisma.service.js';

/** Attribute keys whose values are scopes a person names in a question. */
export const FILTER_KEYS = [
  'site',
  'platform',
  'cluster',
  'role',
  'applicationRole',
  'manufacturer',
  'vendor',
  'family',
  'guestOsFamily',
  'osName',
  'status',
  'purpose',
  'vrf',
  'branch',
] as const;

export interface ResolvedFilter {
  key: string;
  /** The stored value, as written by the collector. */
  value: string;
  /** The word the person used. */
  term: string;
}

interface TenantCatalogue {
  at: number;
  keysByType: Map<CiType, Set<string>>;
  /** key → normalised value → stored value, for keys under the cardinality limit. */
  values: Map<string, Map<string, string>>;
}

interface KeyRow {
  type: CiType;
  key: string;
}

interface ValueRow {
  key: string;
  value: string;
}

@Injectable()
export class AssistantCatalogueService {
  private readonly cache = new Map<string, TenantCatalogue>();

  constructor(private readonly prisma: PrismaService) {}

  private async load(tenantId: string): Promise<TenantCatalogue> {
    const cached = this.cache.get(tenantId);
    if (cached !== undefined && Date.now() - cached.at < ASSISTANT.catalogueCacheMs) return cached;
    const [keyRows, valueRows] = await Promise.all([
      this.prisma.client.$queryRaw<KeyRow[]>(Prisma.sql`
        SELECT DISTINCT c.type::text AS "type", k.key AS "key"
        FROM cis c, jsonb_object_keys(c.attributes) AS k(key)
        WHERE c."tenantId" = ${tenantId}::uuid AND c."validTo" IS NULL`),
      this.prisma.client.$queryRaw<ValueRow[]>(Prisma.sql`
        SELECT kv.key AS "key", kv.value AS "value"
        FROM cis c, jsonb_each_text(c.attributes) AS kv(key, value)
        WHERE c."tenantId" = ${tenantId}::uuid AND c."validTo" IS NULL AND kv.key = ANY(${[...FILTER_KEYS]}::text[]) AND kv.value <> ''
        GROUP BY kv.key, kv.value`),
    ]);
    const keysByType = new Map<CiType, Set<string>>();
    for (const row of keyRows) {
      const set = keysByType.get(row.type) ?? new Set<string>();
      set.add(row.key);
      keysByType.set(row.type, set);
    }
    const perKey = new Map<string, Map<string, string>>();
    for (const row of valueRows) {
      const map = perKey.get(row.key) ?? new Map<string, string>();
      map.set(normalise(row.value), row.value);
      perKey.set(row.key, map);
    }
    const values = new Map<string, Map<string, string>>();
    for (const [key, map] of perKey) if (map.size <= ASSISTANT.filterValueLimit) values.set(key, map);
    const catalogue: TenantCatalogue = { at: Date.now(), keysByType, values };
    this.cache.set(tenantId, catalogue);
    return catalogue;
  }

  /** The first key of the family that the tenant's CIs of this type carry, or null when none does. */
  async keyFor(tenantId: string, type: CiType, family: AttributeFamilyId): Promise<string | null> {
    const catalogue = await this.load(tenantId);
    const present = catalogue.keysByType.get(type);
    if (present === undefined) return null;
    for (const key of ATTRIBUTE_FAMILIES[family].keys) if (present.has(key)) return key;
    return null;
  }

  /** Scope words resolved to (key, stored value) pairs; a word matching several keys takes the first in FILTER_KEYS order. */
  async resolveFilters(
    tenantId: string,
    terms: readonly string[],
  ): Promise<{ resolved: ResolvedFilter[]; unresolved: string[] }> {
    const catalogue = await this.load(tenantId);
    const resolved: ResolvedFilter[] = [];
    const unresolved: string[] = [];
    for (const term of terms) {
      const wanted = normalise(term);
      let hit: ResolvedFilter | null = null;
      for (const key of FILTER_KEYS) {
        const map = catalogue.values.get(key);
        if (map === undefined) continue;
        const exact = map.get(wanted);
        if (exact !== undefined) {
          hit = { key, value: exact, term };
          break;
        }
        for (const [normalised, stored] of map) {
          if (
            normalised.startsWith(wanted) ||
            normalised.replaceAll('_', ' ').startsWith(wanted.replaceAll('_', ' '))
          ) {
            hit = { key, value: stored, term };
            break;
          }
        }
        if (hit !== null) break;
      }
      if (hit === null) unresolved.push(term);
      else resolved.push(hit);
    }
    return { resolved, unresolved };
  }

  forget(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}
