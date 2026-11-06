'use client';
// REQ-CMDB-014 (ADR-037) — how one part reads in the CI Parts tab and the Parts register: its kind, the capacity in the
// largest sensible unit, and the kind-specific details (cores, speeds, MAC, WWPN, media) under localised labels.
import { COMPONENT_KINDS, type ComponentKind } from '@openmap/contracts';
import type { Locale, MessageKey } from '@openmap/i18n';
import { Tag } from '@openmap/ui';
import type { ReactNode } from 'react';
import { formatBytes } from '@/components/dependencies/traffic';
import type { ComponentDetails, HardwareComponent } from '@/lib/component-queries';
import type { Formatters } from '@/lib/format';
import type { Translate } from '@/providers';

/** Detail keys the collectors report, in display order; any other key is shown under its own name. */
export const DETAIL_KEYS = [
  'cores',
  'threads',
  'maxSpeedMhz',
  'type',
  'speedMts',
  'speed',
  'speedMbps',
  'media',
  'transport',
  'role',
  'mac',
  'wwpn',
  'wwnn',
  'portState',
  'capacityWatts',
] as const;

export function kindKey(kind: ComponentKind): MessageKey {
  return ('parts.kind.' + kind) as MessageKey;
}

function detailKey(key: string): MessageKey | null {
  return (DETAIL_KEYS as readonly string[]).includes(key) ? (('parts.detail.' + key) as MessageKey) : null;
}

/** Detail entries in display order: known keys first, the rest alphabetically. */
export function orderedDetails(details: ComponentDetails): Array<[string, string | number | boolean]> {
  const known = DETAIL_KEYS.filter((k) => details[k] !== undefined).map(
    (k): [string, string | number | boolean] => [k, details[k] ?? ''],
  );
  const rest = Object.entries(details)
    .filter(([k]) => !(DETAIL_KEYS as readonly string[]).includes(k))
    .sort(([a], [b]) => a.localeCompare(b));
  return [...known, ...rest];
}

export function kindOrder(kind: ComponentKind): number {
  return COMPONENT_KINDS.indexOf(kind);
}

export function Capacity({
  part,
  locale,
}: {
  part: Pick<HardwareComponent, 'capacityBytes'>;
  locale: Locale;
}): ReactNode {
  return part.capacityBytes === null ? null : (
    <span className="font-om-mono">{formatBytes(locale, part.capacityBytes)}</span>
  );
}

export function PartDetails({
  details,
  t,
  format,
}: {
  details: ComponentDetails;
  t: Translate;
  format: Formatters;
}): ReactNode {
  const entries = orderedDetails(details);
  if (entries.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-om-4">
      {entries.map(([key, value]) => {
        const label = detailKey(key);
        const shown = typeof value === 'number' ? format.integer(value) : String(value);
        return <Tag key={key}>{label === null ? key + ' ' + shown : t(label, { value: shown })}</Tag>;
      })}
    </span>
  );
}
