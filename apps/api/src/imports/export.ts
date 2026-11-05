// REQ-CMDB-033 (ADR-032) — the CI export rows, the pure half: one row per CI with columns named by their import target
// (`type`, `name`, `tags`, `identity.<key>`) so a file exported here re-imports as it is, then the columns an import
// does not read (code, layer, lifecycle, observed, source, attributes and custom fields as JSON).
import { CI_IDENTITY_KEYS, type CiType } from '@openmap/contracts';
import type { CiRecord } from '../ci/ci.types.js';

export const EXPORT_FORMATS = ['csv', 'xlsx', 'json'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** The identity keys the exported types use, in key precedence order, each once. */
export function identityColumns(types: readonly CiType[]): string[] {
  const keys: string[] = [];
  for (const type of types) for (const k of CI_IDENTITY_KEYS[type]) if (!keys.includes(k)) keys.push(k);
  return keys;
}

export function exportHeaders(identityKeys: readonly string[]): string[] {
  return ['type', 'name', 'tags', ...identityKeys.map((k) => 'identity.' + k), 'code', 'displayName', 'layer', 'lifecycle', 'observedAt', 'source', 'attributes', 'customFields'];
}

export function exportRow(ci: CiRecord, identityKeys: readonly string[]): string[] {
  return [
    ci.type,
    ci.name,
    ci.tags.join(';'),
    ...identityKeys.map((k) => ci.identity[k] ?? ''),
    ci.code,
    ci.displayName,
    ci.layer,
    ci.lifecycle,
    ci.observedAt,
    ci.source.collectorId,
    JSON.stringify(ci.attributes),
    JSON.stringify(ci.customFields),
  ];
}

/** The JSON form: the record as the API serves it, without the internal checksum. */
export function exportObject(ci: CiRecord): Record<string, unknown> {
  const { checksum: _checksum, ...rest } = ci;
  return rest;
}
