// REQ-CORE-013 — attribute merge with confidence precedence and change detection by checksum.
import { createHash } from 'node:crypto';
import { RECONCILIATION } from '@openmap/constants';
import type { Attributes, Provenance } from '@openmap/contracts';

export interface Versioned {
  attributes: Attributes;
  source: Provenance;
  observedAt: string;
}

export interface MergeResult {
  attributes: Attributes;
  source: Provenance;
  changed: boolean;
  /** Attribute names whose value changed. */
  changedKeys: string[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/** SHA-256 over the canonical form of (type, identity, attributes); stable across key order. */
export function checksum(type: string, identity: Record<string, string>, attributes: Attributes): string {
  return createHash('sha256').update(canonical({ type, identity, attributes })).digest('hex');
}

function outranks(incoming: Versioned, existing: Versioned): boolean {
  if (incoming.source.confidence > existing.source.confidence) return true;
  if (incoming.source.confidence < existing.source.confidence) return false;
  return incoming.observedAt >= existing.observedAt;
}

/**
 * Merge rules: a higher-confidence (or equal and newer) source overwrites; a lower-confidence source
 * only fills attributes the existing record lacks, and never overwrites when below the floor.
 */
export function merge(existing: Versioned, incoming: Versioned): MergeResult {
  const canOverwrite = outranks(incoming, existing) && incoming.source.confidence >= RECONCILIATION.overwriteMinConfidence;
  const attributes: Attributes = { ...existing.attributes };
  const changedKeys: string[] = [];
  for (const [k, v] of Object.entries(incoming.attributes)) {
    const current = attributes[k];
    if (current === undefined) {
      attributes[k] = v;
      changedKeys.push(k);
    } else if (canOverwrite && canonical(current) !== canonical(v)) {
      attributes[k] = v;
      changedKeys.push(k);
    }
  }
  return { attributes, source: canOverwrite ? incoming.source : existing.source, changed: changedKeys.length > 0, changedKeys };
}
