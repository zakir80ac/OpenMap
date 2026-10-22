'use client';
// REQ-UI-007 REQ-DEP-003 — side panel beside the dependency map: the focus CI, its blast radius, the affected services
// with predicted state, money and SLA budget, and the relationships of the focus CI grouped by family.
import Link from 'next/link';
import { CONSOLE_ALPHA } from '@openmap/constants';
import type { Locale } from '@openmap/i18n';
import { Card, Dot, LayerBadge, Pill, SectionTitle, StateBadge, Tag, cx, withAlpha } from '@openmap/ui';
import type { ReactNode } from 'react';
import { predictedColor, predictedRank, predictedUiState, relationshipColor, type ImpactGraph } from '@/lib/graph-layout';
import { healthKey, layerKey, predictedKey, relationshipKey } from '@/lib/keys';
import { localizedHref } from '@/lib/locale-path';
import type { CiSummary, ImpactResult, RelationshipRow } from '@/lib/queries';
import { useFormatters, useT } from '@/providers';

export interface ImpactPanelProps {
  locale: Locale;
  result: ImpactResult;
  graph: ImpactGraph;
  relationships: RelationshipRow[];
  className?: string;
}

const RADIUS_TINT_ALPHA = CONSOLE_ALPHA.panelTint;
const RADIUS_BORDER_ALPHA = CONSOLE_ALPHA.panelBorder;

function ciHref(locale: Locale, ci: CiSummary): string {
  return localizedHref(locale, '/cmdb/' + encodeURIComponent(ci.id));
}

export function ImpactPanel({ locale, result, graph, relationships, className }: ImpactPanelProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const root = result.root;
  const applications = graph.nodes.filter((n) => n.layer === 'applications' && n.id !== root.id).length;
  const hosts = graph.nodes.filter((n) => (n.layer === 'hardware' || n.layer === 'virtualization') && n.id !== root.id).length;
  const services = [...result.services].sort((a, b) => predictedRank(a.predicted) - predictedRank(b.predicted) || a.tier - b.tier);
  const worst = services[0]?.predicted ?? 'unaffected';
  const radiusAccent = predictedColor(worst === 'unaffected' ? 'at_risk' : worst);

  return (
    <Card as="aside" className={cx('flex flex-col gap-om-16', className)}>
      <div className="flex items-start gap-om-12">
        <div className="min-w-0 flex-1">
          <p className="text-om-2xs font-semibold uppercase tracking-[0.1em] text-om-muted">{root.type}</p>
          <h2 className="truncate font-om-display text-om-lg font-bold text-om-primary">{root.displayName}</h2>
          <p className="truncate font-om-mono text-om-2xs text-om-muted">{root.name}</p>
        </div>
        <StateBadge state={root.health} label={t(healthKey[root.health])} live={root.health !== 'healthy'} />
      </div>
      <div className="flex flex-wrap items-center gap-om-8">
        <LayerBadge layer={root.layer} label={t(layerKey(root.layer))} />
        <Tag>{t('dependencies.panel.query', { ms: format.integer(result.durationMs) })}</Tag>
      </div>

      <section
        aria-label={t('dependencies.panel.blastRadius')}
        className="rounded-om-panel p-om-14"
        style={{ background: withAlpha(radiusAccent, RADIUS_TINT_ALPHA), border: '1px solid ' + withAlpha(radiusAccent, RADIUS_BORDER_ALPHA) }}
      >
        <p className="mb-om-10 text-om-xs font-semibold" style={{ color: radiusAccent }}>
          {t('dependencies.panel.blastRadius')}
        </p>
        <dl className="grid grid-cols-3 gap-om-8 text-center">
          <div>
            <dd className="font-om-display text-om-2xl font-extrabold" style={{ color: predictedColor('down') }}>
              {format.integer(services.length)}
            </dd>
            <dt className="text-om-2xs text-om-secondary">{t('dependencies.panel.services')}</dt>
          </div>
          <div>
            <dd className="font-om-display text-om-2xl font-extrabold" style={{ color: predictedColor('degraded') }}>
              {format.integer(applications)}
            </dd>
            <dt className="text-om-2xs text-om-secondary">{t('dependencies.panel.applications')}</dt>
          </div>
          <div>
            <dd className="font-om-display text-om-2xl font-extrabold text-om-primary">{format.integer(hosts)}</dd>
            <dt className="text-om-2xs text-om-secondary">{t('dependencies.panel.hosts')}</dt>
          </div>
        </dl>
      </section>

      <section className="flex flex-col gap-om-8">
        <SectionTitle as="h3" size="sm">
          {t('dependencies.panel.affected')}
        </SectionTitle>
        {services.length === 0 ? (
          <p className="text-om-sm text-om-secondary">{t('dependencies.panel.noServices')}</p>
        ) : (
          <ul className="flex flex-col gap-om-8">
            {services.map((item) => (
              <li key={item.service.id} className="rounded-om-panel border border-om-border-glass bg-om-surface2/60 p-om-10">
                <div className="flex items-center gap-om-8">
                  <Dot state={predictedUiState(item.predicted)} pulse={item.predicted === 'down'} />
                  <Link href={ciHref(locale, item.service)} className="min-w-0 flex-1 truncate text-om-sm font-medium text-om-primary hover:text-om-cyan">
                    {item.service.displayName}
                  </Link>
                  <Tag variant="state" state={predictedUiState(item.predicted)}>
                    {t(predictedKey[item.predicted])}
                  </Tag>
                </div>
                <div className="mt-om-6 flex flex-wrap gap-x-om-12 gap-y-om-4 text-om-2xs text-om-secondary">
                  <span>{t('dependencies.panel.tier', { tier: format.integer(item.tier) })}</span>
                  {item.usersAffected !== null ? <span>{t('dependencies.panel.users', { count: format.integer(item.usersAffected) })}</span> : null}
                  {item.revenueAtRiskPerHour !== null ? (
                    <span className="text-om-rose">
                      {t('dependencies.panel.revenue', { amount: format.number(item.revenueAtRiskPerHour.amount), currency: item.revenueAtRiskPerHour.currency })}
                    </span>
                  ) : null}
                  {item.slaBudgetRemainingMinutes !== null ? (
                    <span className={cx(item.slaBudgetRemainingMinutes <= 0 && 'text-om-rose')}>
                      {t('dependencies.panel.slaBudget', { minutes: format.integer(item.slaBudgetRemainingMinutes) })}
                    </span>
                  ) : null}
                  {item.recovery !== null ? <span>{t('dependencies.panel.recovery', { minutes: format.integer(item.recovery.estimatedMinutes) })}</span> : null}
                </div>
                <ol className="mt-om-8 flex flex-wrap items-center gap-om-4 text-om-2xs text-om-muted" aria-label={t('dependencies.panel.path')}>
                  {item.path.map((id, index) => {
                    const node = graph.nodes.find((n) => n.id === id);
                    return (
                      <li key={id + String(index)} className="flex items-center gap-om-4">
                        {index > 0 ? <span aria-hidden="true">→</span> : null}
                        <span className={cx(node?.id === root.id && 'text-om-primary')}>{node?.label ?? item.service.displayName}</span>
                      </li>
                    );
                  })}
                </ol>
              </li>
            ))}
          </ul>
        )}
      </section>

      {relationships.length > 0 ? (
        <section className="flex flex-col gap-om-8">
          <SectionTitle as="h3" size="sm">
            {t('dependencies.panel.relationships')}
          </SectionTitle>
          <ul className="flex flex-col">
            {relationships.map((rel) => {
              const other = rel.from.id === root.id ? rel.to : rel.from;
              return (
                <li key={rel.id} className="flex items-center gap-om-10 border-b border-om-border-glass py-om-6 text-om-sm last:border-b-0">
                  <span aria-hidden="true" className="inline-block size-2 shrink-0 rounded-om-pill" style={{ background: relationshipColor(rel.type) }} />
                  <span className="w-28 shrink-0 truncate text-om-2xs font-semibold uppercase tracking-[0.06em] text-om-muted">{t(relationshipKey(rel.type))}</span>
                  <Link href={ciHref(locale, other)} className="min-w-0 flex-1 truncate text-om-primary hover:text-om-cyan">
                    {other.displayName}
                  </Link>
                  <span className="truncate font-om-mono text-om-2xs text-om-muted">{other.type}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <div className="mt-auto flex gap-om-8">
        <Link
          href={ciHref(locale, root)}
          className="flex flex-1 items-center justify-center rounded-om-control-lg bg-om-cyan px-om-12 py-om-8 text-om-sm font-semibold text-om-ground shadow-om-glow-button-cyan transition-opacity duration-om-base hover:opacity-90"
        >
          {t('dependencies.panel.openCi')}
        </Link>
        <Link href={localizedHref(locale, '/services')} className="flex flex-1 items-center justify-center">
          <Pill>{t('nav.services')}</Pill>
        </Link>
      </div>
    </Card>
  );
}
