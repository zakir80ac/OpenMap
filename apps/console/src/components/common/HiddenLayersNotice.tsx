'use client';
// REQ-CMDB-021 — the one notice every estate-wide list shows while this device hides layers (REQ-UI-005 visibility):
// which layers are left out, a control to show them all again, and the way to the Layers screen where they are set.
// Lists apply the same rule: hidden layers are excluded unless the person picks one explicitly (`visibleLayersFilter`).
import { CI_LAYERS, type CiLayer } from '@openmap/contracts';
import type { Locale } from '@openmap/i18n';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button } from '@/components/common/controls';
import { useLayerVisibility, type LayerVisibility } from '@/hooks/useLayerVisibility';
import { layerKey } from '@/lib/keys';
import { localizedHref } from '@/lib/locale-path';
import { useT } from '@/providers';

/** The layers a list should ask for: the one picked, else the visible ones while any is hidden, else no restriction. */
export function visibleLayersFilter(
  visibility: LayerVisibility,
  picked: CiLayer | null | undefined,
): CiLayer[] | null {
  if (picked !== null && picked !== undefined) return [picked];
  const visible = CI_LAYERS.filter((layer) => visibility[layer]);
  return visible.length === CI_LAYERS.length ? null : visible;
}

export function hiddenLayers(visibility: LayerVisibility): CiLayer[] {
  return CI_LAYERS.filter((layer) => !visibility[layer]);
}

export function HiddenLayersNotice({ locale }: { locale: Locale }): ReactNode {
  const t = useT();
  const { visibility, showAll } = useLayerVisibility();
  const hidden = hiddenLayers(visibility);
  if (hidden.length === 0) return null;
  const names = new Intl.ListFormat(locale, { type: 'conjunction' }).format(
    hidden.map((layer) => t(layerKey(layer))),
  );
  return (
    <div
      role="status"
      data-testid="hidden-layers"
      className="flex flex-wrap items-center gap-om-10 rounded-om-control border border-om-border-glass bg-om-surface2 px-om-12 py-om-8 text-om-xs text-om-secondary"
    >
      <span>{t('layers.hidden.notice', { layers: names })}</span>
      <Button tone="quiet" onClick={showAll}>
        {t('layers.hidden.showAll')}
      </Button>
      <Link href={localizedHref(locale, '/layers')} className="text-om-cyan hover:text-om-primary">
        {t('layers.hidden.manage')}
      </Link>
    </div>
  );
}
