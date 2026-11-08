'use client';
// REQ-UI-005 REQ-UI-033 — Layers: the twelve-layer model with counts from the `layers` query, per-device visibility
// switches with the platforms each layer holds, and the stack beside them (ADR-021): planes in contract order as the
// overview, click a plane or its row's focus control to zoom onto that layer's equipment, Escape or Back to return.
// REQ-AI-002: below them, the suggested classifications for unknown CIs (ClassificationPanel).
import { useQuery } from '@tanstack/react-query';
import { CI_LAYERS, type CiLayer } from '@openmap/contracts';
import { Card, Pill, SectionTitle, cx, layerColor } from '@openmap/ui';
import Link from 'next/link';
import * as icons from 'simple-icons';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/common/controls';
import { Icon } from '@/components/icons';
import { QueryState } from '@/components/common/QueryState';
import { useLayerVisibility } from '@/hooks/useLayerVisibility';
import { layerKey } from '@/lib/keys';
import { LAYER_MARKS, buildStackModel, type Mark } from '@/lib/layer-stack-model';
import { localizedHref } from '@/lib/locale-path';
import { layersQuery } from '@/lib/queries';
import { useFormatters, useLocale, useT } from '@/providers';
import { ClassificationPanel } from './ClassificationPanel';
import { LayerStack3DLazy } from './LayerStack3DLazy';

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
        checked ? 'border-om-cyan/40 bg-om-cyan/30' : 'border-om-border-strong bg-om-surface3',
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

interface IconEntry {
  title: string;
  hex: string;
  path: string;
}

function iconFor(slug: string): IconEntry | null {
  const key = 'si' + slug.charAt(0).toUpperCase() + slug.slice(1);
  return (icons as unknown as Record<string, IconEntry | undefined>)[key] ?? null;
}

/** The platforms a layer holds: the vendor's mark from the CC0 catalogue, or its name where no mark may be used. */
export function VendorMarks({ marks, className }: { marks: readonly Mark[]; className?: string }): ReactNode {
  if (marks.length === 0) return null;
  return (
    <span className={cx('flex flex-wrap items-center gap-om-6', className)} data-part="marks">
      {marks.map((mark) => {
        if (mark.kind === 'word') {
          return (
            <span key={mark.text} className="rounded-om-tag border border-om-border-glass bg-om-surface2 px-om-6 py-om-2 font-om-body text-om-2xs text-om-secondary">
              {mark.text}
            </span>
          );
        }
        const icon = iconFor(mark.slug);
        if (icon === null) return null;
        return (
          <span key={mark.slug} className="grid size-5 place-items-center rounded-om-tag border border-om-border-glass bg-om-surface2" title={icon.title}>
            <svg viewBox="0 0 24 24" width="12" height="12" role="img" aria-label={icon.title}>
              <path d={icon.path} fill={'#' + icon.hex} />
            </svg>
          </span>
        );
      })}
    </span>
  );
}

export function LayersView(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const locale = useLocale();
  const { visibility, toggle, showAll, visibleCount } = useLayerVisibility();
  const layers = useQuery(layersQuery());
  const byLayer = useMemo(() => new Map((layers.data ?? []).map((summary) => [summary.layer, summary])), [layers.data]);
  const allVisible = visibleCount === CI_LAYERS.length;
  const model = useMemo(() => buildStackModel(byLayer, visibility), [byLayer, visibility]);
  const labels = useMemo(() => Object.fromEntries(CI_LAYERS.map((layer) => [layer, t(layerKey(layer))])) as Record<CiLayer, string>, [t]);
  const [hovered, setHovered] = useState<CiLayer | null>(null);
  const [focused, setFocused] = useState<CiLayer | null>(null);
  const focusedPlane = focused === null ? undefined : model.planes.find((p) => p.layer === focused);

  // Escape leaves focus; the Back control does the same for pointer and touch.
  useEffect(() => {
    if (focused === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFocused(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [focused]);

  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle
        as="h1"
        size="lg"
        eyebrow={t('app.name')}
        description={t('layers.subtitle')}
        action={
          <Pill variant={allVisible ? 'default' : 'primary'} onClick={showAll}>
            {t('layer.showAll')}
          </Pill>
        }
      >
        {t('nav.layers')}
      </SectionTitle>

      <div className="grid grid-cols-1 gap-om-16 xl:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
        <Card as="section" className="flex flex-col gap-om-12">
          <SectionTitle size="sm" description={t('layers.visibleCount', { visible: format.integer(visibleCount), total: format.integer(CI_LAYERS.length) })}>
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
            {[...CI_LAYERS].reverse().map((layer) => {
              const summary = byLayer.get(layer);
              const visible = visibility[layer];
              const label = t(layerKey(layer));
              const color = layerColor(layer);
              const isFocused = focused === layer;
              return (
                <li
                  key={layer}
                  data-layer={layer}
                  data-hovered={hovered === layer ? 'true' : undefined}
                  data-focused={isFocused ? 'true' : undefined}
                  onMouseEnter={() => {
                    setHovered(layer);
                  }}
                  onMouseLeave={() => {
                    setHovered(null);
                  }}
                  className={cx(
                    'flex items-center gap-om-10 border-b border-om-border-glass px-om-6 py-om-8 transition-[opacity,background-color] duration-om-base ease-om-standard last:border-b-0',
                    !visible && 'opacity-50',
                    (hovered === layer || isFocused) && 'bg-om-surface2/70',
                  )}
                >
                  <span aria-hidden="true" className="size-2.5 shrink-0 rounded-om-pill" style={{ background: color }} />
                  <button
                    type="button"
                    aria-pressed={isFocused}
                    aria-label={t('layers.focusOn', { layer: label })}
                    onClick={() => {
                      setFocused(isFocused ? null : layer);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-om-10 text-start"
                  >
                    <span className="w-40 truncate text-om-sm font-medium text-om-primary">{label}</span>
                    <VendorMarks marks={LAYER_MARKS[layer]} className="hidden lg:flex" />
                    <span className="ms-auto w-16 text-end font-om-mono text-om-xs tabular-nums text-om-secondary">{summary === undefined ? PENDING_VALUE : format.integer(summary.count)}</span>
                  </button>
                  <span className="hidden items-center gap-om-8 font-om-mono text-om-2xs tabular-nums md:flex">
                    {summary === undefined ? null : (
                      <>
                        <span className="text-om-state-healthy">{format.integer(summary.healthy)}</span>
                        <span className="text-om-state-degraded">{format.integer(summary.degraded)}</span>
                        <span className="text-om-state-down">{format.integer(summary.down)}</span>
                      </>
                    )}
                  </span>
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

        <Card as="section" className="flex min-h-[38rem] flex-col gap-om-12">
          <SectionTitle
            size="sm"
            description={focused === null ? t('layers.stackHint') : t('layers.focusHint')}
            action={
              focused !== null ? (
                <Button
                  tone="quiet"
                  onClick={() => {
                    setFocused(null);
                  }}
                >
                  {t('layers.backToStack')}
                </Button>
              ) : undefined
            }
          >
            {t('layers.stack')}
          </SectionTitle>
          <LayerStack3DLazy model={model} labels={labels} formatInteger={format.integer} hovered={hovered} focused={focused} onHover={setHovered} onFocus={(layer) => { setFocused((current) => (current === layer ? null : layer)); }} />
          {focusedPlane !== undefined ? (
            <section aria-label={t('layers.focusPanel')} data-testid="layer-focus-panel" className="flex flex-wrap items-center gap-om-16 rounded-om-panel border border-om-border-glass bg-om-surface2/60 px-om-14 py-om-10">
              <span className="flex items-center gap-om-8">
                <span aria-hidden="true" className="size-2.5 rounded-om-pill" style={{ background: layerColor(focusedPlane.layer) }} />
                <span className="font-om-display text-om-md font-semibold text-om-primary">{labels[focusedPlane.layer]}</span>
              </span>
              <span className="font-om-mono text-om-sm tabular-nums text-om-primary">{format.integer(focusedPlane.count)}</span>
              <span className="font-om-mono text-om-2xs tabular-nums">
                <span className="text-om-state-healthy">{format.integer(focusedPlane.healthy)}</span> · <span className="text-om-state-degraded">{format.integer(focusedPlane.degraded)}</span> · <span className="text-om-state-down">{format.integer(focusedPlane.down)}</span>
              </span>
              <VendorMarks marks={focusedPlane.marks} />
              <Link href={localizedHref(locale, '/cmdb') + '?layer=' + focusedPlane.layer} className="ms-auto inline-flex items-center gap-om-6 text-om-xs text-om-cyan hover:underline">
                {t('layers.openInCmdb')}
                <Icon name="arrowRight" />
              </Link>
            </section>
          ) : null}
          {/* The same planes as text, for assistive technology and the e2e: name, count, health, visibility. */}
          <ul className="sr-only" aria-label={t('layers.stack')} data-testid="layer-stack-tiers">
            {model.planes.map((plane) => (
              <li key={plane.layer} data-layer={plane.layer} data-visible={plane.visible ? 'true' : 'false'}>
                {labels[plane.layer]} · {format.integer(plane.count)} · {t('layers.health', { healthy: format.integer(plane.healthy), degraded: format.integer(plane.degraded), down: format.integer(plane.down) })} · {plane.visible ? t('layers.visible') : t('layers.hidden')}
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <ClassificationPanel locale={locale} />
    </div>
  );
}
