// REQ-DEP-002 (ADR-029) — the observed-traffic rows of the focus CI: `depends_on` relationships the reconciler derived
// from flows, read from their evidence attributes (protocol, ports, flows, bytes, processes, window, confidence) in
// either direction, so the panel can say what this CI talks to and what talks to it. A plain module so the view test
// and the panel share one reading of the attributes.
import { ADM, BYTES } from '@openmap/constants';
import type { Locale } from '@openmap/i18n';
import type { CiSummary, JsonValue, RelationshipRow } from '@/lib/queries';

export type TrafficDirection = 'to' | 'from';

export interface TrafficRow {
  id: string;
  direction: TrafficDirection;
  other: CiSummary;
  protocol: string;
  ports: number[];
  flows: number;
  bytes: number;
  processes: string[];
  lastSeen: string | null;
  confidence: number;
  ambiguous: boolean;
}

function num(value: JsonValue | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function strs(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function nums(value: JsonValue | undefined): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [];
}

/** True for an edge the dependency-mapping pass derived from flows. */
export function isDerivedFromFlows(rel: Pick<RelationshipRow, 'attributes'>): boolean {
  return rel.attributes[ADM.derivedFromKey] === ADM.derivedFromFlows;
}

/** The derived edges touching the root, busiest first. */
export function observedTraffic(relationships: readonly RelationshipRow[], rootId: string): TrafficRow[] {
  const rows: TrafficRow[] = [];
  for (const rel of relationships) {
    if (!isDerivedFromFlows(rel)) continue;
    const a = rel.attributes;
    const direction: TrafficDirection = rel.from.id === rootId ? 'to' : 'from';
    rows.push({
      id: rel.id,
      direction,
      other: direction === 'to' ? rel.to : rel.from,
      protocol: typeof a['protocol'] === 'string' ? a['protocol'] : '',
      ports: nums(a['ports']),
      flows: num(a['flows']),
      bytes: num(a['bytes']),
      processes: strs(a['processes']),
      lastSeen: typeof a['lastSeen'] === 'string' ? a['lastSeen'] : null,
      confidence: typeof a['confidence'] === 'number' ? a['confidence'] : rel.source.confidence,
      ambiguous: a['ambiguous'] === true,
    });
  }
  return rows.sort((x, y) => y.flows - x.flows || x.other.displayName.localeCompare(y.other.displayName));
}

/** Bytes in the largest unit that keeps the number above one, to BYTES.decimals. */
export function formatBytes(locale: Locale, bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= BYTES.perUnit && unit < BYTES.units.length - 1) {
    value /= BYTES.perUnit;
    unit += 1;
  }
  const label = BYTES.units[unit] ?? BYTES.units[0];
  return new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 0 ? 0 : BYTES.decimals }).format(value) + ' ' + label;
}
