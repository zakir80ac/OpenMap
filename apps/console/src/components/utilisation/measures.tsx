'use client';
// REQ-CMDB-034 — how a utilisation value reads: a percentage bar coloured by how close it is to the hot threshold
// (UTILISATION.hotPercent), power in watts, and the hot or idle tag.
import { UTILISATION } from '@openmap/constants';
import type { UtilisationMeasure, UtilisationState } from '@openmap/contracts';
import type { MessageKey } from '@openmap/i18n';
import { Bar, Tag, accents, type HexColor } from '@openmap/ui';
import type { ReactNode } from 'react';
import type { Formatters } from '@/lib/format';
import type { Translate } from '@/providers';

export function measureKey(measure: UtilisationMeasure): MessageKey {
  return ('utilisation.measure.' + measure) as MessageKey;
}

export function stateKey(state: UtilisationState): MessageKey {
  return ('utilisation.state.' + state) as MessageKey;
}

export function percentAccent(value: number): HexColor {
  if (value >= UTILISATION.hotPercent) return accents.rose;
  if (value >= UTILISATION.hotPercent - UTILISATION.warningMarginPercent) return accents.amber;
  if (value <= UTILISATION.idlePercent) return accents.steel;
  return accents.cyan;
}

/** A measured value as text: percentages to one decimal, watts whole. */
/** A share rounded to UTILISATION.percentDecimals, in the locale's digits. */
export function percentText(value: number, t: Translate, format: Formatters): string {
  return t('utilisation.percent', {
    value: format.number(Number(value.toFixed(UTILISATION.percentDecimals))),
  });
}

export function measureText(unit: string, value: number, t: Translate, format: Formatters): string {
  return unit === 'W'
    ? t('utilisation.watts', { value: format.integer(value) })
    : percentText(value, t, format);
}

export function PercentCell({
  value,
  label,
  format,
  t,
}: {
  value: number | null;
  label: string;
  format: Formatters;
  t: Translate;
}): ReactNode {
  if (value === null) return <span className="text-om-muted">{t('common.none')}</span>;
  return (
    <span className="flex min-w-24 items-center gap-om-8">
      <Bar
        value={value}
        max={UTILISATION.fullPercent}
        accent={percentAccent(value)}
        label={label}
        className="flex-1"
        glowing={false}
      />
      <span className="w-12 text-end font-om-mono text-om-xs tabular-nums text-om-secondary">
        {percentText(value, t, format)}
      </span>
    </span>
  );
}

export function StateTag({ state, t }: { state: UtilisationState; t: Translate }): ReactNode {
  if (state === 'hot')
    return (
      <Tag variant="state" state="at_risk">
        {t(stateKey(state))}
      </Tag>
    );
  return <Tag>{t(stateKey(state))}</Tag>;
}
