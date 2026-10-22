// REQ-UI-008 REQ-CMDB-037 — pure helpers for the CI detail: short code, attribute value classification for display,
// and the attribute diff behind the time-travel History tab.
import { CI_TYPES, ciCode, type CiLayer, type CiType } from '@openmap/contracts';
import type { CiSummary, JsonValue } from './queries';

export function isCiType(value: string): value is CiType {
  return (CI_TYPES as readonly string[]).includes(value);
}

/** The short code people say aloud (NET-ARISTA-SPINE1); unknown types still get their layer prefix. */
export function codeFor(ci: Pick<CiSummary, 'layer' | 'type' | 'name'>): string {
  return ciCode(ci.layer, isCiType(ci.type) ? ci.type : 'unknown', ci.name);
}

export type ValueKind = 'null' | 'boolean' | 'number' | 'date' | 'text' | 'list' | 'object';

/** ISO-8601 date or date-time as collectors emit it; built from a string so the pattern carries no numeric literal. */
const ISO_DATE = new RegExp('^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})?)?$');

export function isIsoDate(value: string): boolean {
  return ISO_DATE.test(value) && !Number.isNaN(new Date(value).getTime());
}

export function valueKind(value: JsonValue | undefined): ValueKind {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return isIsoDate(value) ? 'date' : 'text';
  if (Array.isArray(value)) return 'list';
  return 'object';
}

/** Canonical JSON with sorted object keys so two equal values always serialise identically. */
export function stableStringify(value: JsonValue | undefined): string {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

export type AttributeChange = 'added' | 'removed' | 'changed';

export interface AttributeDiffRow {
  key: string;
  /** Value at the earlier instant (undefined when the attribute did not exist then). */
  before: JsonValue | undefined;
  /** Current value (undefined when the attribute no longer exists). */
  after: JsonValue | undefined;
  change: AttributeChange;
}

/** Attributes that differ between an earlier version and now, sorted by key; equal attributes are omitted. */
export function diffAttributes(before: Record<string, JsonValue>, after: Record<string, JsonValue>): AttributeDiffRow[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const rows: AttributeDiffRow[] = [];
  for (const key of [...keys].sort()) {
    const hasBefore = Object.hasOwn(before, key);
    const hasAfter = Object.hasOwn(after, key);
    if (hasBefore && !hasAfter) rows.push({ key, before: before[key], after: undefined, change: 'removed' });
    else if (!hasBefore && hasAfter) rows.push({ key, before: undefined, after: after[key], change: 'added' });
    else if (stableStringify(before[key]) !== stableStringify(after[key])) rows.push({ key, before: before[key], after: after[key], change: 'changed' });
  }
  return rows;
}

/** Relationship rows grouped by type, each with the CI on the other end and the direction as seen from `selfId`. */
export interface RelationshipGroup<TRow extends { type: string; from: CiSummary; to: CiSummary }> {
  type: string;
  rows: Array<{ row: TRow; other: CiSummary; outgoing: boolean }>;
}

export function groupRelationships<TRow extends { type: string; from: CiSummary; to: CiSummary }>(rows: ReadonlyArray<TRow>, selfId: string): RelationshipGroup<TRow>[] {
  const groups = new Map<string, RelationshipGroup<TRow>>();
  for (const row of rows) {
    const outgoing = row.from.id === selfId;
    const other = outgoing ? row.to : row.from;
    const group = groups.get(row.type) ?? { type: row.type, rows: [] };
    group.rows.push({ row, other, outgoing });
    groups.set(row.type, group);
  }
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || a.type.localeCompare(b.type));
}

/** Layers a user may label a CI with: every layer except the bucket the CI is leaving. */
export function labelableLayers(layers: readonly CiLayer[]): CiLayer[] {
  return layers.filter((layer) => layer !== 'unknown');
}
