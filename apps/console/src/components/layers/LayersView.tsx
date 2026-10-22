'use client';
// REQ-UI-005 — Layers: the twelve-layer model with counts from the `layers` query, per-device visibility switches
// and the isometric stack that reflects them.
import { useQuery } from '@tanstack/react-query';
import { CI_LAYERS } from '@openmap/contracts';
import { Card, Pill, SectionTitle, cx, glow, layerColor } from '@openmap/ui';
import { useMemo, type ReactNode } from 'react';
import { QueryState } from '@/components/common/QueryState';
import { useLayerVisibility } from '@/hooks/useLayerVisibility';
import { layerKey } from '@/lib/keys';
import { layersQuery } from '@/lib/queries';
import { useFormatters, useT } from '@/providers';
import { LayerStack } from './LayerStack';

const PENDING_VALUE = '…';

interface VisibilitySwitchProps {
  checked: boolean;
  label: string;
  onToggle: () => void;
}

function VisibilitySwitch({ checked, label, onToggle }: VisibilitySwitchProps): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
      className={cx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-om-pill border transition-colors duration-om-base ease-om-standard',
        checked ? 'border-om-cyan/40 bg-om-cyan/30 shadow-om-glow-bar-cyan' : 'border-om-border-strong bg-om-surface3',
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          'absolute size-3.5 rounded-om-pill bg-om-primary transition-[inset-inline-start] duration-om-base ease-om-standard',
          checked ? 'start-[18px]' : 'start-[2px]',
        )}
      />
    </button>
  );
}

export function LayersView(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const { visibility, toggle, showAll, visibleCount } = useLayerVisibility();
  const layers = useQuery(layersQuery());
  const counts = useMemo(() => new Map((layers.data ?? []).map((summary) => [summary.layer, summary.count])), [layers.data]);
  const byLayer = useMemo(() => new Map((layers.data ?? []).map((summary) => [summary.layer, summary])), [layers.data]);
  const allVisible = visibleCount === CI_LAYERS.length;

  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle
        as="h1"
        size="lg"
        eyebrow={t('app.name')}
        description={t('layers.subtitle')}
        action={
          <Pill variant={allVisible ? 'default' : 'primary'} onClick={showAll} glowing={!allVisible}>
            {t('layer.showAll')}
          </Pill>
        }
      >
        {t('nav.layers')}
      </SectionTitle>

      <div className="grid grid-cols-1 gap-om-16 xl:grid-cols-[3fr_2fr]">
        <Card as="section" className="flex flex-col gap-om-12">
          <SectionTitle
            size="sm"
            description={t('layers.visibleCount', { visible: format.integer(visibleCount), total: format.integer(CI_LAYERS.length) })}
          >
            {t('layer.visibility')}
          </SectionTitle>
          {layers.isError ? (
            <QueryState
              status="error"
              onRetry={() => {
                void layers.refetch();
              }}
            />
          ) : null}
          <ul className="flex flex-col" aria-busy={layers.isPending}>
            {CI_LAYERS.map((layer) => {
              const summary = byLayer.get(layer);
              const visible = visibility[layer];
              const label = t(layerKey(layer));
              const color = layerColor(layer);
              return (
                <li
                  key={layer}
                  data-layer={layer}
                  className={cx(
                    'flex items-center gap-om-12 border-b border-om-border-glass py-om-10 transition-opacity duration-om-base ease-om-standard last:border-b-0',
                    !visible && 'opacity-50',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="size-2.5 shrink-0 rounded-om-pill"
                    style={{ background: color, boxShadow: visible ? glow('bar', color) : undefined }}
                  />
                  <span className="w-44 truncate text-om-sm font-medium text-om-primary">{label}</span>
                  <span className="w-16 font-om-mono text-om-xs tabular-nums text-om-secondary">
                    {summary === undefined ? PENDING_VALUE : format.integer(summary.count)}
                  </span>
                  <span className="ms-auto hidden items-center gap-om-10 font-om-mono text-om-2xs tabular-nums md:flex">
                    {summary === undefined ? null : (
                      <>
                        <span className="text-om-state-healthy">{format.integer(summary.healthy)}</span>
                        <span className="text-om-state-degraded">{format.integer(summary.degraded)}</span>
                        <span className="text-om-state-down">{format.integer(summary.down)}</span>
                      </>
                    )}
                  </span>
                  <span className="w-14 text-end text-om-2xs text-om-muted">{visible ? t('layers.visible') : t('layers.hidden')}</span>
                  <VisibilitySwitch
                    checked={visible}
                    label={t('layers.toggle', { layer: label })}
                    onToggle={() => {
                      toggle(layer);
                    }}
                  />
                </li>
              );
            })}
          </ul>
        </Card>

        <Card as="section" className="flex flex-col gap-om-16">
          <SectionTitle size="sm">{t('layers.stack')}</SectionTitle>
          <LayerStack visibility={visibility} counts={counts} className="w-full" />
        </Card>
      </div>
    </div>
  );
}
