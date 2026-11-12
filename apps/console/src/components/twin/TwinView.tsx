'use client';
// REQ-UI-029 — Digital twin screen: the estate's rooms, racks and devices in real 3D from the `racks` query, with the
// focus CI's dependency graph (the `impact` query, laid out like the 2D map) floating on the layer planes above.
// Pick a focus with the same search the dependency map uses; click a rack or a node for its details and a link to
// the CMDB or DCIM. The scene is a client-only chunk loaded after the page paints.
// REQ-UI-037: an open rack's devices take clicks (in the scene or the rack's list), and the side panel drills from the
// device through its components, compute, OS, databases, applications, services, network, storage and security.
import { useQuery } from '@tanstack/react-query';
import { GRAPH } from '@openmap/constants';
import type { Locale } from '@openmap/i18n';
import { Card, Kpi, LayerBadge, Pill, SectionTitle, StateBadge, Tag, accents, cx } from '@openmap/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import { QueryState } from '@/components/common/QueryState';
import { Field, Select } from '@/components/common/controls';
import { FocusSearch } from '@/components/dependencies/FocusSearch';
import { useLayerVisibility } from '@/hooks/useLayerVisibility';
import { racksQuery } from '@/lib/estate-queries';
import { buildImpactGraph } from '@/lib/graph-layout';
import { healthKey, layerKey, predictedKey } from '@/lib/keys';
import { localizedHref } from '@/lib/locale-path';
import { impactQuery, type CiSummary } from '@/lib/queries';
import { buildFacilityModel, buildGraphModel, type FacilityModel, type GraphModel, type RackBox } from '@/lib/twin-model';
import { useFormatters, useT } from '@/providers';
import { TwinDrillPanel, type DrillStep } from './TwinDrillPanel';
import type { TwinSelection } from './TwinScene';
import { TwinSceneLazy } from './TwinSceneLazy';

export interface TwinViewProps {
  locale: Locale;
}

export function TwinView({ locale }: TwinViewProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const router = useRouter();
  const params = useSearchParams();
  const ciId = params.get('ci') ?? undefined;
  const { visibility } = useLayerVisibility();
  const racks = useQuery(racksQuery());
  const impact = useQuery({ ...impactQuery({ ciId: ciId ?? '', direction: 'both', maxDepth: GRAPH.defaultImpactDepth, asOf: null }), enabled: ciId !== undefined });
  const [selected, setSelected] = useState<TwinSelection | null>(null);
  const [hovered, setHovered] = useState<TwinSelection | null>(null);
  // The levels drilled below the selected rack: the device first, then whatever was picked from it.
  const [trail, setTrail] = useState<DrillStep[]>([]);

  const facility = useMemo<FacilityModel | null>(() => (racks.data === undefined ? null : buildFacilityModel(racks.data, t('twin.unplaced'))), [racks.data, t]);
  const graph = useMemo(() => (impact.data === undefined ? undefined : buildImpactGraph(impact.data, visibility)), [impact.data, visibility]);
  const graphModel = useMemo<GraphModel | null>(() => {
    if (graph === undefined || impact.data === undefined || facility === null) return null;
    return buildGraphModel(graph, impact.data.root.id, facility.center);
  }, [graph, impact.data, facility]);

  const focus: CiSummary | undefined = impact.data?.root;
  const selectedDevice = selected?.kind === 'device' ? facility?.devices.find((d) => d.id === selected.id) : undefined;
  const selectedRack: RackBox | undefined =
    selected?.kind === 'rack' ? facility?.racks.find((r) => r.id === selected.id) : selectedDevice === undefined ? undefined : facility?.racks.find((r) => r.id === selectedDevice.rackId);
  const selectedNode = selected?.kind === 'node' ? graphModel?.nodes.find((n) => n.id === selected.id) : undefined;

  /** A selection from the scene: a device starts the drill-down at itself, anything else clears it. */
  const select = (next: TwinSelection | null): void => {
    setSelected(next);
    const device = next?.kind === 'device' ? facility?.devices.find((d) => d.id === next.id) : undefined;
    setTrail(device === undefined ? [] : [{ id: device.id, label: device.name }]);
  };
  const drill = (step: DrillStep): void => {
    // A device picked from the rack's list is selected in the scene too.
    if (trail.length === 0 && facility?.devices.some((d) => d.id === step.id) === true) setSelected({ kind: 'device', id: step.id });
    setTrail([...trail, step]);
  };
  const backTo = (index: number): void => {
    if (index < 0) {
      if (selectedRack !== undefined) setSelected({ kind: 'rack', id: selectedRack.id });
      setTrail([]);
      return;
    }
    setTrail(trail.slice(0, index + 1));
  };

  const pick = (ci: CiSummary): void => {
    setSelected(null);
    setTrail([]);
    router.replace(localizedHref(locale, '/twin') + '?ci=' + encodeURIComponent(ci.id));
  };
  const rackCaption = (rack: RackBox): string => t('twin.rack.caption', { name: rack.name, units: format.integer(rack.units), load: format.integer(rack.loadPercent) });

  return (
    <div className="flex flex-col gap-om-20">
      <SectionTitle as="h1" size="lg" eyebrow={t('app.name')} description={focus === undefined ? t('twin.subtitle') : t('twin.focusOn', { name: focus.displayName })}>
        {t('nav.twin')}
      </SectionTitle>

      <Card padding="16" className="flex flex-wrap items-end gap-om-12">
        <FocusSearch current={focus} onPick={pick} className="min-w-72 flex-1" />
        {focus === undefined ? null : (
          <Pill
            variant="violet"
            onClick={() => {
              setSelected(null);
              router.replace(localizedHref(locale, '/twin'));
            }}
          >
            {t('twin.clearFocus')}
          </Pill>
        )}
        <span className="text-om-2xs text-om-muted">{t('twin.controls.hint')}</span>
      </Card>

      <section className="grid grid-cols-2 gap-om-12 md:grid-cols-4" aria-busy={racks.isPending}>
        <Card padding="16"><Kpi label={t('twin.kpi.rooms')} value={facility === null ? '' : format.integer(facility.rooms.length)} accent={accents.violet} /></Card>
        <Card padding="16"><Kpi label={t('twin.kpi.racks')} value={facility === null ? '' : format.integer(facility.racks.length)} accent={accents.cyan} /></Card>
        <Card padding="16"><Kpi label={t('twin.kpi.devices')} value={facility === null ? '' : format.integer(facility.devices.length)} /></Card>
        <Card padding="16"><Kpi label={t('twin.kpi.nodes')} value={graphModel === null ? format.integer(0) : format.integer(graphModel.nodes.length)} {...(graphModel === null ? {} : { accent: accents.emerald })} /></Card>
      </section>

      <div className="grid grid-cols-1 gap-om-16 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card padding="4" className="relative overflow-hidden">
          <div className="h-[min(72dvh,56rem)] w-full" data-testid="twin-canvas">
            {racks.isPending ? (
              <QueryState status="pending" className="m-om-12" />
            ) : racks.isError || facility === null ? (
              <QueryState
                status="error"
                className="m-om-12"
                onRetry={() => {
                  void racks.refetch();
                }}
              />
            ) : (
              <TwinSceneLazy facility={facility} graph={graphModel} selected={selected} hovered={hovered} onHover={setHovered} onSelect={select} label={t('twin.canvas.aria')} rackCaption={rackCaption} />
            )}
          </div>
          {graphModel === null ? null : (
            <ul aria-label={t('twin.planes.label')} className="absolute inset-s-om-12 top-om-12 flex flex-col gap-om-4">
              {[...graphModel.planes].reverse().map((plane) => (
                <li key={plane.layer}>
                  <LayerBadge layer={plane.layer} label={t(layerKey(plane.layer)) + ' · ' + format.integer(plane.nodeCount)} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card as="aside" padding="16" className="flex max-h-[min(72dvh,56rem)] flex-col gap-om-12 overflow-y-auto" aria-label={t('twin.panel.title')}>
          <SectionTitle as="h2" size="sm">{t('twin.panel.title')}</SectionTitle>
          {selectedRack !== undefined ? (
            <TwinDrillPanel locale={locale} rack={selectedRack} trail={trail} onDrill={drill} onTrail={backTo} onFocus={pick} />
          ) : selectedNode !== undefined ? (
            <div className="flex flex-col gap-om-10">
              <p className="font-om-display text-om-lg font-bold text-om-primary">{selectedNode.label}</p>
              <p className="font-om-mono text-om-2xs text-om-muted">{selectedNode.type}</p>
              <div className="flex flex-wrap gap-om-6">
                <LayerBadge layer={selectedNode.layer} label={t(layerKey(selectedNode.layer))} />
                <StateBadge state={selectedNode.health} label={t(healthKey[selectedNode.health])} />
                <Tag>{t(predictedKey[selectedNode.predicted])}</Tag>
                <Tag>{t('common.hops', { count: format.integer(selectedNode.depth) })}</Tag>
              </div>
              <div className="flex flex-wrap gap-om-8">
                <Link href={localizedHref(locale, '/cmdb/' + encodeURIComponent(selectedNode.id))}><Pill variant="primary">{t('twin.panel.openCi')}</Pill></Link>
                <Pill
                  onClick={() => {
                    pick({ id: selectedNode.id, name: selectedNode.label, displayName: selectedNode.label, code: '', type: selectedNode.type, layer: selectedNode.layer, health: selectedNode.health });
                  }}
                >
                  {t('twin.panel.focusHere')}
                </Pill>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-om-10">
              <p className={cx('text-om-sm text-om-secondary')}>{t('twin.panel.none')}</p>
              {facility === null || facility.racks.length === 0 ? null : (
                // The same rack without the scene: for the keyboard and screen readers (REQ-UI-037).
                <Field id="twin-rack-pick" label={t('twin.drill.pickRack')}>
                  <Select
                    id="twin-rack-pick"
                    value=""
                    onChange={(event) => {
                      if (event.target.value !== '') select({ kind: 'rack', id: event.target.value });
                    }}
                  >
                    <option value="">{t('twin.drill.pickRackNone')}</option>
                    {facility.racks.map((rack) => (
                      <option key={rack.id} value={rack.id}>
                        {rack.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
          )}
          {impact.isError ? <QueryState status="error" onRetry={() => { void impact.refetch(); }} /> : null}
        </Card>
      </div>
    </div>
  );
}
