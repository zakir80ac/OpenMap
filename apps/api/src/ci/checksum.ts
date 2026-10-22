// REQ-CMDB-001 — CI checksum: SHA-256 of the canonical JSON of (type, identity, attributes), with
// object keys sorted so logically equal CIs hash identically regardless of key order.
import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

export function checksumOf(type: string, identity: Record<string, unknown>, attributes: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson({ type, identity, attributes })).digest('hex');
}
