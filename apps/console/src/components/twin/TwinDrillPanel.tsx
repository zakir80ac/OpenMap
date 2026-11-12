'use client';
// REQ-UI-037 — the digital twin's drill-down panel. From a rack to a device in it, and from there through everything the
// CMDB relates to it: hardware components, the hypervisor with its VMs and containers, the operating system, databases,
// applications, the business services it supports (through the graph), network, storage, security and its place. Each
// neighbour drills one level further; the breadcrumb returns to any level, and every level opens its CI or focuses the
// dependency layers on it.
import { useQuery } from '@tanstack/react-query';
import { GRAPH, TWIN } from '@openmap/constants';
import type { Locale, MessageKey } from '@openmap/i18n';
import { LayerBadge, Pill, StateBadge, Tag } from '@openmap/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { QueryState } from '@/components/common/QueryState';
import { healthKey, layerKey, relationshipKey } from '@/lib/keys';
import { localizedHref } from '@/lib/locale-path';
import { impactQuery, type CiSummary } from '@/lib/queries';
import { drillSections, twinDrillQuery, type DrillCi, type DrillItem, type DrillSection } from '@/lib/twin-drill';
import type { RackBox } from '@/lib/twin-model';
import { useFormatters, useT } from '@/providers';

/** One level below the rack: the CI drilled into and the name shown in the breadcrumb. */
export interface DrillStep {
  id: string;
  label: string;
}

export interface TwinDrillPanelProps {
  locale: Locale;
  rack: RackBox;
  trail: readonly DrillStep[];
  /** Go one level deeper. */
  onDrill: (step: DrillStep) => void;
  /** Return to a level: -1 is the rack. */
  onTrail: (index: number) => void;
  /** Lay the CI's dependencies on the layer planes. */
  onFocus: (ci: CiSummary) => void;
}

/** The vulnerability feed's top severity label (CVSS v3 Critical). */
const CRITICAL_SEVERITY = 'critical';

const BUTTON_CLASS =
  'flex w-full min-w-0 items-center gap-om-8 rounded-om-panel border border-om-border-glass bg-om-surface2/60 px-om-10 py-om-6 text-start text-om-xs transition-colors duration-om-base ease-om-standard hover:border-om-cyan/50 hover:bg-om-surface3';

export function TwinDrillPanel({ locale, rack, trail, onDrill, onTrail, onFocus }: TwinDrillPanelProps): ReactNode {
  const t = useT();
  const current = trail[trail.length - 1];
  return (
    <div className="flex min-w-0 flex-col gap-om-10">
      <nav aria-label={t('twin.drill.trail')}>
        <ol className="flex flex-wrap items-center gap-om-4 text-om-2xs">
          <li>
            <button type="button" className={current === undefined ? 'font-semibold text-om-primary' : 'text-om-cyan hover:text-om-primary'} aria-current={current === undefined ? 'location' : undefined} onClick={() => { onTrail(-1); }}>
              {rack.name}
            </button>
          </li>
          {trail.map((step, index) => (
            <li key={step.id + String(index)} className="flex items-center gap-om-4">
              <span aria-hidden="true" className="text-om-muted rtl:rotate-180">›</span>
              <button type="button" className={index === trail.length - 1 ? 'font-semibold text-om-primary' : 'text-om-cyan hover:text-om-primary'} aria-current={index === trail.length - 1 ? 'location' : undefined} onClick={() => { onTrail(index); }}>
                {step.label}
              </button>
            </li>
          ))}
        </ol>
      </nav>
      {current === undefined ? <RackLevel locale={locale} rack={rack} onDrill={onDrill} /> : <CiLevel key={current.id} locale={locale} id={current.id} onDrill={onDrill} onFocus={onFocus} />}
    </div>
  );
}

function RackLevel({ locale, rack, onDrill }: { locale: Locale; rack: RackBox; onDrill: (step: DrillStep) => void }): ReactNode {
  const t = useT();
  const format = useFormatters();
  return (
    <div className="flex flex-col gap-om-10">
      <p className="font-om-display text-om-lg font-bold text-om-primary">{rack.name}</p>
      <p className="font-om-mono text-om-2xs text-om-muted">{rack.ci.code}</p>
      <div className="flex flex-wrap gap-om-6">
        <Tag>{t('twin.rack.units', { occupied: format.integer(rack.occupiedUnits), total: format.integer(rack.units) })}</Tag>
        <Tag variant="state" state={rack.loadPercent >= TWIN.loadHotPercent ? 'down' : rack.loadPercent >= TWIN.loadWarnPercent ? 'degraded' : 'healthy'}>{t('twin.rack.load', { load: format.integer(rack.loadPercent) })}</Tag>
      </div>
      <p className="text-om-2xs text-om-secondary">{t('twin.drill.pickDevice')}</p>
      <ul className="flex flex-col gap-om-4" aria-label={t('twin.rack.devices')}>
        {[...rack.devices].sort((a, b) => b.startUnit - a.startUnit).map((device) => (
          <li key={device.id}>
            <button type="button" className={BUTTON_CLASS} aria-label={t('twin.drill.into', { name: device.name })} onClick={() => { onDrill({ id: device.id, label: device.name }); }}>
              <span className="w-10 shrink-0 font-om-mono text-om-2xs text-om-muted">{'U' + format.integer(device.startUnit)}</span>
              <span className="min-w-0 flex-1 truncate font-medium text-om-primary">{device.name}</span>
              <span className="truncate font-om-mono text-om-2xs text-om-muted">{device.ci.type}</span>
              <StateBadge state={device.ci.health} label={t(healthKey[device.ci.health])} />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-om-8">
        <Link href={localizedHref(locale, '/cmdb/' + encodeURIComponent(rack.id))}><Pill variant="primary">{t('twin.panel.openCi')}</Pill></Link>
        <Link href={localizedHref(locale, '/dcim')}><Pill>{t('twin.panel.openDcim')}</Pill></Link>
      </div>
    </div>
  );
}

function CiLevel({ locale, id, onDrill, onFocus }: { locale: Locale; id: string; onDrill: (step: DrillStep) => void; onFocus: (ci: CiSummary) => void }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const drill = useQuery(twinDrillQuery(id));
  // The services a CI supports are found by walking up the graph, not only from its direct links.
  const upstream = useQuery(impactQuery({ ciId: id, direction: 'upstream', maxDepth: GRAPH.defaultImpactDepth, asOf: null }));
  if (drill.isPending) return <QueryState status="pending" />;
  if (drill.isError || drill.data === null) return <QueryState status="error" onRetry={() => { void drill.refetch(); }} />;
  const ci: DrillCi = drill.data;
  const relationships = ci.relationships.edges.map((e) => e.node);
  const sections = drillSections(ci.id, relationships, upstream.data?.services ?? []);
  const hasSecurity = sections.some((s) => s.key === 'security') || ci.vulnerabilities.length > 0;
  const hardware = sections.find((s) => s.key === 'components')?.items ?? [];
  const drillTo = (target: CiSummary): void => { onDrill({ id: target.id, label: target.displayName }); };
  return (
    // Busy while the upstream walk for the services it supports is still out.
    <div className="flex flex-col gap-om-12" data-testid="twin-drill-level" aria-busy={upstream.isPending}>
      <div className="flex flex-col gap-om-4">
        <p className="font-om-display text-om-lg font-bold text-om-primary">{ci.displayName}</p>
        <p className="font-om-mono text-om-2xs text-om-muted">{ci.code + ' · ' + ci.type}</p>
        <div className="flex flex-wrap gap-om-6">
          <LayerBadge layer={ci.layer} label={t(layerKey(ci.layer))} />
          <StateBadge state={ci.health} label={t(healthKey[ci.health])} />
        </div>
      </div>
      <div className="flex flex-wrap gap-om-8">
        <Link href={localizedHref(locale, '/cmdb/' + encodeURIComponent(ci.id))}><Pill variant="primary">{t('twin.panel.openCi')}</Pill></Link>
        <Pill onClick={() => { onFocus(ci); }}>{t('twin.panel.focusHere')}</Pill>
      </div>

      {/* The parts collectors reported and the hardware CIs related to it (a BMC, a chassis) read as one section. */}
      {ci.components.length > 0 || hardware.length > 0 ? (
        <DrillGroup title={t('twin.drill.section.components')} count={ci.components.length + hardware.length}>
          {ci.components.map((part) => (
            <li key={part.id} className="flex min-w-0 items-center gap-om-8 rounded-om-panel border border-om-border-glass bg-om-surface2/40 px-om-10 py-om-6 text-om-xs">
              <span className="w-24 shrink-0 text-om-2xs text-om-muted">{t(('parts.kind.' + part.kind) as MessageKey)}</span>
              <span className="min-w-0 flex-1 truncate text-om-primary">{part.model ?? t('parts.unknownModel')}</span>
              <span className="truncate font-om-mono text-om-2xs text-om-muted">{part.slot}</span>
            </li>
          ))}
          {hardware.map((item) => (
            <NeighbourRow key={item.ci.id + (item.relation ?? '') + String(item.outgoing)} item={item} onPick={drillTo} />
          ))}
        </DrillGroup>
      ) : null}

      {sections.map((section) =>
        section.key === 'security' || section.key === 'components' ? null : <NeighbourGroup key={section.key} section={section} onPick={drillTo} />,
      )}

      {hasSecurity ? (
        <DrillGroup title={t('twin.drill.section.security')} count={ci.vulnerabilities.length + (sections.find((s) => s.key === 'security')?.items.length ?? 0)}>
          {[...ci.vulnerabilities].sort((a, b) => b.cvss - a.cvss).map((v) => (
            <li key={v.cveId} className="flex min-w-0 flex-wrap items-center gap-om-6 rounded-om-panel border border-om-border-glass bg-om-surface2/40 px-om-10 py-om-6 text-om-xs">
              <span className="font-om-mono text-om-primary">{v.cveId}</span>
              <Tag variant="state" state={v.severity.toLowerCase() === CRITICAL_SEVERITY ? 'down' : 'degraded'}>{t('twin.drill.cvss', { score: format.number(v.cvss) })}</Tag>
              {v.exploited ? <Tag variant="state" state="down">{t('twin.drill.exploited')}</Tag> : null}
              {v.internetFacing ? <Tag>{t('twin.drill.internetFacing')}</Tag> : null}
            </li>
          ))}
          {(sections.find((s) => s.key === 'security')?.items ?? []).map((item) => (
            <NeighbourRow key={item.ci.id + (item.relation ?? '')} item={item} onPick={drillTo} />
          ))}
        </DrillGroup>
      ) : null}

      {sections.length === 0 && ci.components.length === 0 && ci.vulnerabilities.length === 0 ? (
        <p className="text-om-sm text-om-secondary">{t('twin.drill.empty')}</p>
      ) : null}
      {ci.relationships.totalCount > relationships.length ? (
        <p className="text-om-2xs text-om-muted">{t('twin.drill.more', { shown: format.integer(relationships.length), total: format.integer(ci.relationships.totalCount) })}</p>
      ) : null}
    </div>
  );
}

function DrillGroup({ title, count, children }: { title: string; count: number; children: ReactNode }): ReactNode {
  const format = useFormatters();
  return (
    <section aria-label={title} className="flex flex-col gap-om-6">
      <h3 className="flex items-center gap-om-8 text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
        {title}
        <span className="rounded-om-pill bg-om-surface3 px-om-6 text-om-secondary">{format.integer(count)}</span>
      </h3>
      <ul className="flex flex-col gap-om-4">{children}</ul>
    </section>
  );
}

function NeighbourGroup({ section, onPick }: { section: DrillSection; onPick: (ci: CiSummary) => void }): ReactNode {
  const t = useT();
  return (
    <DrillGroup title={t(('twin.drill.section.' + section.key) as MessageKey)} count={section.items.length}>
      {section.items.map((item) => (
        <NeighbourRow key={item.ci.id + (item.relation ?? '') + String(item.outgoing)} item={item} onPick={onPick} />
      ))}
    </DrillGroup>
  );
}

function NeighbourRow({ item, onPick }: { item: DrillItem; onPick: (ci: CiSummary) => void }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const how =
    item.relation === null
      ? t('twin.drill.viaGraph', { hops: format.integer(item.hops ?? 1) })
      : t(item.outgoing ? 'cmdb.detail.relationships.outgoing' : 'cmdb.detail.relationships.incoming') + ' ' + t(relationshipKey(item.relation));
  return (
    <li>
      <button type="button" className={BUTTON_CLASS} aria-label={t('twin.drill.into', { name: item.ci.displayName })} onClick={() => { onPick(item.ci); }}>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-om-primary">{item.ci.displayName}</span>
          <span className="block truncate text-om-2xs text-om-muted">{how + ' · ' + item.ci.type}</span>
        </span>
        <StateBadge state={item.ci.health} label={t(healthKey[item.ci.health])} />
      </button>
    </li>
  );
}
