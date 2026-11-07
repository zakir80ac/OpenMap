'use client';
// REQ-UI-013 REQ-BSM-003 REQ-AI-004 REQ-CMDB-021 — Impact modeling ("What if…"): component explorer (search + layer filter,
// multi-select) → condition picker (applicability from type and layer) → Run model: saveScenario then
// runSimulation → results (totals, propagation chains, affected services with predicted state, SLA budget and
// recovery) → assistant suggestions (askAssistant grounded on the scenario, plus the engine's recommendations) and
// the saved scenarios list from impactScenarios; below, the prediction accuracy against real incidents (REQ-BSM-004).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLES } from '@openmap/constants';
import { useCan } from '@/lib/auth';
import Link from 'next/link';
import { ASSISTANT, CONSOLE, GRAPH } from '@openmap/constants';
import { CI_LAYERS, type CiLayer } from '@openmap/contracts';
import type { Locale } from '@openmap/i18n';
import { Card, Dot, LayerBadge, Pill, SectionTitle, StateBadge, Tag, cx, layerColor } from '@openmap/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { QueryState } from '@/components/common/QueryState';
import { ImpactAccuracyPanel } from '@/components/impact/ImpactAccuracyPanel';
import { Icon } from '@/components/icons';
import { predictedUiState } from '@/lib/graph-layout';
import {
  applicableConditions,
  isImpactCondition,
  summariseNames,
  type ImpactCondition,
} from '@/lib/impact-conditions';
import { healthKey, layerKey, predictedKey } from '@/lib/keys';
import { localizedHref } from '@/lib/locale-path';
import {
  askAssistant,
  cisPageQuery,
  impactScenariosQuery,
  runSimulation,
  saveScenario,
  searchQuery,
  type AssistantAnswer,
  type CiSummary,
  type ImpactScenario,
  type ImpactSimulation,
} from '@/lib/queries';
import { useFormatters, useT, type Translate } from '@/providers';
import { HiddenLayersNotice, visibleLayersFilter } from '@/components/common/HiddenLayersNotice';
import { useLayerVisibility } from '@/hooks/useLayerVisibility';

export interface ImpactViewProps {
  locale: Locale;
}

const fieldClass =
  'h-10 w-full rounded-om-control-lg border border-om-border-glass bg-om-surface1/80 px-om-10 text-om-sm text-om-primary outline-none transition-[border-color,box-shadow] duration-om-base ease-om-standard focus:border-om-cyan/40 focus:shadow-om-glow-bar-cyan';

function useDebounced(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      window.clearTimeout(handle);
    };
  }, [value, delayMs]);
  return debounced;
}

function conditionLabel(t: Translate, condition: ImpactCondition): string {
  return t(`impact.condition.${condition}.label`);
}

function componentsLabel(t: Translate, components: ReadonlyArray<CiSummary>): string {
  const { listed, more } = summariseNames(
    components.map((c) => c.displayName),
    ASSISTANT.summaryNames,
  );
  return more > 0 ? listed.join(', ') + ' ' + t('impact.andMore', { count: more }) : listed.join(', ');
}

function ciHref(locale: Locale, ci: Pick<CiSummary, 'id'>): string {
  return localizedHref(locale, '/cmdb/' + encodeURIComponent(ci.id));
}

interface RunOutcome {
  simulation: ImpactSimulation;
  condition: ImpactCondition;
}

export function ImpactView({ locale }: ImpactViewProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const queryClient = useQueryClient();

  const [text, setText] = useState('');
  const [layer, setLayer] = useState<CiLayer | undefined>(undefined);
  const [selected, setSelected] = useState<Map<string, CiSummary>>(new Map());
  const [condition, setCondition] = useState<ImpactCondition | undefined>(undefined);
  const debounced = useDebounced(text.trim(), CONSOLE.searchDebounceMs);

  const { visibility } = useLayerVisibility();
  // REQ-CMDB-021: layers hidden on this device stay out of the explorer unless one is picked.
  const layers = visibleLayersFilter(visibility, layer) ?? undefined;
  const page = useQuery({
    ...cisPageQuery(layers === undefined ? {} : { layers }),
    enabled: debounced === '',
  });
  const hits = useQuery(
    searchQuery({
      text: debounced,
      ...(layers === undefined ? {} : { layers }),
      first: CONSOLE.explorerPageSize,
    }),
  );
  const components: CiSummary[] =
    debounced === '' ? (page.data?.items ?? []) : (hits.data?.map((hit) => hit.ci) ?? []);
  const total = debounced === '' ? page.data?.totalCount : hits.data?.length;
  const listPending = debounced === '' ? page.isPending : hits.isPending;

  const chosen = useMemo(() => [...selected.values()], [selected]);
  const conditions = useMemo(() => applicableConditions(chosen), [chosen]);
  const activeCondition =
    condition !== undefined && conditions.some((c) => c.id === condition) ? condition : undefined;

  const scenarios = useQuery(impactScenariosQuery());

  const can = useCan();
  const allowed = can(ROLES.operator);
  const assistant = useMutation({ mutationFn: (question: string) => askAssistant(question, locale) });
  const askAbout = (outcome: RunOutcome): void => {
    const question = t('impact.assistant.question', {
      components: componentsLabel(t, outcome.simulation.failedCis),
      condition: conditionLabel(t, outcome.condition),
      down: format.integer(outcome.simulation.totals.servicesDown),
      degraded: format.integer(outcome.simulation.totals.servicesDegraded),
    });
    assistant.mutate(question);
  };

  const run = useMutation({
    mutationFn: async (input: {
      components: CiSummary[];
      condition: ImpactCondition;
    }): Promise<RunOutcome> => {
      const scenario = await saveScenario({
        name: t('impact.scenarioName', {
          condition: conditionLabel(t, input.condition),
          components: componentsLabel(t, input.components),
        }),
        kind: input.condition,
        failedCiIds: input.components.map((c) => c.id),
        maxDepth: GRAPH.defaultImpactDepth,
      });
      const simulation = await runSimulation(scenario.id);
      return { simulation, condition: input.condition };
    },
    onSuccess: (outcome) => {
      void queryClient.invalidateQueries({ queryKey: ['impact-scenarios'] });
      askAbout(outcome);
    },
  });

  const rerun = useMutation({
    mutationFn: async (scenario: ImpactScenario): Promise<RunOutcome> => ({
      simulation: await runSimulation(scenario.id),
      condition: isImpactCondition(scenario.kind) ? scenario.kind : 'failed',
    }),
    onSuccess: (outcome) => {
      setSelected(new Map(outcome.simulation.failedCis.map((ci) => [ci.id, ci])));
      setCondition(outcome.condition);
      askAbout(outcome);
    },
  });

  const outcome = rerun.data ?? run.data;
  const running = run.isPending || rerun.isPending;
  const canRun = chosen.length > 0 && activeCondition !== undefined && !running;

  const toggleComponent = (ci: CiSummary): void => {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(ci.id)) next.delete(ci.id);
      else next.set(ci.id, ci);
      return next;
    });
  };

  const clear = (): void => {
    setSelected(new Map());
    setCondition(undefined);
    run.reset();
    rerun.reset();
    assistant.reset();
  };

  const nameOf = (simulation: ImpactSimulation, id: string): string =>
    [
      ...simulation.failedCis,
      ...simulation.affectedApplications,
      ...simulation.services.map((s) => s.service),
    ].find((ci) => ci.id === id)?.displayName ?? id;

  return (
    <div className="flex flex-col gap-om-20">
      <SectionTitle
        as="h1"
        size="lg"
        eyebrow={t('nav.services')}
        description={t('impact.subtitle')}
        action={
          <span className="flex items-center gap-om-8">
            <Pill onClick={clear}>{t('impact.clear')}</Pill>
            {allowed ? null : (
              <span className="text-om-xs text-om-muted">
                {t('auth.requiresRole', { role: ROLES.operator })}
              </span>
            )}
            <button
              type="button"
              disabled={!canRun || !allowed}
              title={allowed ? undefined : t('auth.requiresRole', { role: ROLES.operator })}
              onClick={() => {
                if (activeCondition !== undefined)
                  run.mutate({ components: chosen, condition: activeCondition });
              }}
              className="flex items-center gap-om-6 rounded-om-control-lg bg-om-cyan px-om-14 py-om-8 text-om-sm font-semibold text-om-ground shadow-om-glow-button-cyan transition-opacity duration-om-base hover:opacity-90 disabled:opacity-50 disabled:shadow-none"
            >
              <Icon name="play" className="size-3.5" />
              {running ? t('impact.running') : outcome === undefined ? t('impact.run') : t('impact.rerun')}
            </button>
          </span>
        }
      >
        {t('impact.title')}
      </SectionTitle>

      <div className="grid grid-cols-1 gap-om-16 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)]">
        {/* Start column: explorer and condition */}
        <div className="flex flex-col gap-om-16">
          <Card as="section" className="flex flex-col gap-om-12">
            <SectionTitle
              as="h2"
              size="sm"
              action={
                <Tag>
                  {t('impact.explorer.count', {
                    shown: format.integer(components.length),
                    total: total === undefined ? '…' : format.integer(total),
                  })}
                </Tag>
              }
            >
              {t('impact.step.explorer')}
            </SectionTitle>
            <label className="relative flex items-center">
              <Icon name="search" className="pointer-events-none absolute start-3 size-4 text-om-muted" />
              <input
                type="search"
                value={text}
                aria-label={t('impact.explorer.search')}
                autoComplete="off"
                onChange={(event) => {
                  setText(event.target.value);
                }}
                className={cx(fieldClass, 'ps-9')}
              />
              {text === '' ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute start-9 truncate text-om-sm text-om-muted"
                >
                  {t('impact.explorer.search')}
                </span>
              ) : null}
            </label>
            <HiddenLayersNotice locale={locale} />
            <div role="group" aria-label={t('impact.explorer.layers')} className="flex flex-wrap gap-om-4">
              <Pill
                variant={layer === undefined ? 'primary' : 'default'}
                selected={layer === undefined}
                glowing={false}
                onClick={() => {
                  setLayer(undefined);
                }}
              >
                {t('impact.explorer.allLayers')}
              </Pill>
              {CI_LAYERS.map((candidate) => (
                <Pill
                  key={candidate}
                  variant={layer === candidate ? 'primary' : 'default'}
                  selected={layer === candidate}
                  glowing={false}
                  icon={
                    <span
                      aria-hidden="true"
                      className="inline-block size-2 rounded-om-pill"
                      style={{ background: layerColor(candidate) }}
                    />
                  }
                  className={cx(!visibility[candidate] && layer !== candidate && 'opacity-60')}
                  onClick={() => {
                    setLayer(layer === candidate ? undefined : candidate);
                  }}
                >
                  {t(layerKey(candidate))}
                </Pill>
              ))}
            </div>
            {listPending ? (
              <QueryState status="pending" />
            ) : components.length === 0 ? (
              <p className="text-om-sm text-om-secondary">{t('impact.explorer.empty')}</p>
            ) : (
              <ul
                aria-label={t('impact.explorer.list')}
                className="flex max-h-96 flex-col gap-om-4 overflow-y-auto"
              >
                {components.map((ci) => {
                  const picked = selected.has(ci.id);
                  return (
                    <li key={ci.id}>
                      <button
                        type="button"
                        aria-pressed={picked}
                        onClick={() => {
                          toggleComponent(ci);
                        }}
                        className={cx(
                          'flex w-full items-center gap-om-10 rounded-om-panel border px-om-10 py-om-8 text-start text-om-sm transition-colors duration-om-fast',
                          picked
                            ? 'border-om-cyan/40 bg-om-cyan/10 text-om-primary shadow-om-glow-bar-cyan'
                            : 'border-om-border-glass bg-om-surface2/60 text-om-secondary hover:bg-om-surface3/60',
                        )}
                      >
                        <Dot state={ci.health} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-om-primary">{ci.displayName}</span>
                          <span className="block truncate font-om-mono text-om-2xs text-om-muted">
                            {ci.type}
                          </span>
                        </span>
                        <LayerBadge layer={ci.layer} label={t(layerKey(ci.layer))} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {chosen.length > 0 ? (
              <div className="flex flex-wrap items-center gap-om-6 border-t border-om-border-glass pt-om-10">
                <Tag>{t('impact.explorer.selected', { count: format.integer(chosen.length) })}</Tag>
                {chosen.map((ci) => (
                  <Pill
                    key={ci.id}
                    variant="primary"
                    glowing={false}
                    onClick={() => {
                      toggleComponent(ci);
                    }}
                  >
                    {ci.displayName}
                  </Pill>
                ))}
              </div>
            ) : null}
          </Card>

          <Card as="section" className="flex flex-col gap-om-12">
            <SectionTitle
              as="h2"
              size="sm"
              action={
                chosen.length > 0 ? (
                  <Tag>{t('impact.applicable', { count: format.integer(conditions.length) })}</Tag>
                ) : undefined
              }
            >
              {t('impact.step.condition')}
            </SectionTitle>
            {chosen.length === 0 ? (
              <p className="text-om-sm text-om-secondary">{t('impact.condition.pickFirst')}</p>
            ) : (
              <>
                <p className="text-om-xs text-om-secondary">
                  {chosen.length === 1 && chosen[0] !== undefined
                    ? t('impact.condition.hint', {
                        name: chosen[0].displayName,
                        type: chosen[0].type,
                        layer: t(layerKey(chosen[0].layer)),
                      })
                    : t('impact.condition.mixed', { count: format.integer(chosen.length) })}
                </p>
                {conditions.length === 0 ? (
                  <p className="text-om-sm text-om-rose">{t('impact.condition.none')}</p>
                ) : (
                  <ul
                    role="radiogroup"
                    aria-label={t('impact.condition.list')}
                    className="flex flex-col gap-om-4"
                  >
                    {conditions.map((spec) => {
                      const on = activeCondition === spec.id;
                      return (
                        <li key={spec.id}>
                          <button
                            type="button"
                            role="radio"
                            aria-checked={on}
                            onClick={() => {
                              setCondition(spec.id);
                            }}
                            className={cx(
                              'flex w-full items-start gap-om-10 rounded-om-panel border px-om-10 py-om-8 text-start transition-colors duration-om-fast',
                              on
                                ? 'border-om-cyan/40 bg-om-cyan/10 shadow-om-glow-bar-cyan'
                                : 'border-om-border-glass bg-om-surface2/60 hover:bg-om-surface3/60',
                            )}
                          >
                            <Dot state={spec.severity} className="mt-om-6" />
                            <span className="min-w-0 flex-1">
                              <span className="block text-om-sm font-medium text-om-primary">
                                {conditionLabel(t, spec.id)}
                              </span>
                              <span className="block text-om-xs text-om-secondary">
                                {t(`impact.condition.${spec.id}.desc`)}
                              </span>
                            </span>
                            <Tag variant="state" state={spec.severity}>
                              {t(predictedKey[spec.severity])}
                            </Tag>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </Card>
        </div>

        {/* Middle column: results */}
        <div className="flex flex-col gap-om-16">
          {run.isError || rerun.isError ? (
            <Card>
              <QueryState status="error" />
              <p className="mt-om-8 text-om-sm text-om-secondary">{t('impact.result.error')}</p>
              <p className="mt-om-4 font-om-mono text-om-xs text-om-muted">
                {(run.error ?? rerun.error)?.message}
              </p>
            </Card>
          ) : null}
          {outcome === undefined ? (
            <Card className="flex min-h-72 flex-col items-center justify-center gap-om-8 text-center">
              {running ? (
                <QueryState status="pending" />
              ) : (
                <>
                  <p className="font-om-display text-om-lg font-bold text-om-primary">
                    {t('impact.result.idleTitle')}
                  </p>
                  <p className="max-w-md text-om-sm text-om-secondary">{t('impact.result.idleBody')}</p>
                </>
              )}
            </Card>
          ) : (
            <>
              <section
                aria-label={t('impact.step.result')}
                className="grid grid-cols-2 gap-om-10 md:grid-cols-4"
              >
                <Card padding="14">
                  <p className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
                    {t('impact.servicesDown')}
                  </p>
                  <p className="font-om-display text-om-2xl font-extrabold text-om-rose">
                    {format.integer(outcome.simulation.totals.servicesDown)}
                  </p>
                </Card>
                <Card padding="14">
                  <p className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
                    {t('impact.servicesDegraded')}
                  </p>
                  <p className="font-om-display text-om-2xl font-extrabold text-om-amber">
                    {format.integer(outcome.simulation.totals.servicesDegraded)}
                  </p>
                </Card>
                <Card padding="14">
                  <p className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
                    {t('impact.result.atRisk')}
                  </p>
                  <p className="font-om-display text-om-2xl font-extrabold text-om-violet-light">
                    {format.integer(
                      outcome.simulation.services.filter((s) => s.predicted === 'at_risk').length,
                    )}
                  </p>
                </Card>
                <Card padding="14">
                  <p className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
                    {t('impact.result.usersRevenue')}
                  </p>
                  <p className="font-om-display text-om-lg font-extrabold text-om-primary">
                    {format.integer(outcome.simulation.totals.usersAffected)}
                    {outcome.simulation.totals.revenueAtRiskPerHour !== null
                      ? ' · ' +
                        format.number(outcome.simulation.totals.revenueAtRiskPerHour.amount) +
                        ' ' +
                        outcome.simulation.totals.revenueAtRiskPerHour.currency
                      : ''}
                  </p>
                </Card>
              </section>

              <Card as="section" className="flex flex-col gap-om-14">
                <SectionTitle
                  as="h2"
                  size="sm"
                  description={t('impact.result.meta', {
                    ms: format.integer(outcome.simulation.durationMs),
                    components: format.integer(outcome.simulation.failedCis.length),
                    when: format.dateTime(outcome.simulation.ranAt),
                  })}
                >
                  {t('impact.step.result')}
                </SectionTitle>
                <p className="text-om-sm text-om-primary">
                  {t('impact.result.narrative', {
                    components: componentsLabel(t, outcome.simulation.failedCis),
                    condition: conditionLabel(t, outcome.condition),
                    down: format.integer(outcome.simulation.totals.servicesDown),
                    degraded: format.integer(outcome.simulation.totals.servicesDegraded),
                    users: format.integer(outcome.simulation.totals.usersAffected),
                    revenue:
                      outcome.simulation.totals.revenueAtRiskPerHour === null
                        ? t('common.none')
                        : format.number(outcome.simulation.totals.revenueAtRiskPerHour.amount) +
                          ' ' +
                          outcome.simulation.totals.revenueAtRiskPerHour.currency,
                  })}
                </p>
                <p className="text-om-xs text-om-secondary">
                  {t('impact.result.applications', {
                    count: format.integer(outcome.simulation.affectedApplications.length),
                  })}
                </p>

                <h3 className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
                  {t('impact.result.propagation')}
                </h3>
                {outcome.simulation.services.length === 0 ? (
                  <p className="text-om-sm text-om-secondary">{t('impact.result.noServices')}</p>
                ) : (
                  <ul className="flex flex-col gap-om-6">
                    {outcome.simulation.services.map((service) => (
                      <li
                        key={service.service.id}
                        className="flex flex-wrap items-center gap-om-6 rounded-om-panel border border-om-border-glass bg-om-surface2/60 px-om-10 py-om-8 text-om-xs"
                      >
                        {service.path.map((id, index) => (
                          <span key={id + String(index)} className="flex items-center gap-om-6">
                            {index > 0 ? (
                              <span aria-hidden="true" className="text-om-muted">
                                →
                              </span>
                            ) : null}
                            <span
                              className={cx(
                                'rounded-om-tag px-om-6 py-om-4',
                                index === 0 ? 'bg-om-rose/15 text-om-rose' : 'bg-om-surface3 text-om-primary',
                              )}
                            >
                              {nameOf(outcome.simulation, id)}
                            </span>
                          </span>
                        ))}
                        <span className="ms-auto">
                          <Tag variant="state" state={predictedUiState(service.predicted)}>
                            {t(predictedKey[service.predicted])}
                          </Tag>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <h3 className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
                  {t('impact.result.affected')}
                </h3>
                {outcome.simulation.services.length > 0 ? (
                  <table className="w-full border-collapse text-om-sm">
                    <thead>
                      <tr className="border-b border-om-border-glass text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
                        <th scope="col" className="py-om-6 text-start">
                          {t('impact.result.column.service')}
                        </th>
                        <th scope="col" className="py-om-6 text-start">
                          {t('impact.result.column.predicted')}
                        </th>
                        <th scope="col" className="py-om-6 text-start">
                          {t('impact.result.column.sla')}
                        </th>
                        <th scope="col" className="py-om-6 text-start">
                          {t('impact.result.column.recovery')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {outcome.simulation.services.map((service) => (
                        <tr
                          key={service.service.id}
                          className="border-b border-om-border-glass align-top last:border-b-0"
                        >
                          <td className="py-om-8 pe-om-10">
                            <Link
                              href={ciHref(locale, service.service)}
                              className="block truncate font-medium text-om-primary hover:text-om-cyan"
                            >
                              {service.service.displayName}
                            </Link>
                            <span className="block text-om-2xs text-om-muted">
                              {t('impact.result.tier', { tier: format.integer(service.tier) })}
                              {service.usersAffected !== null
                                ? ' · ' +
                                  t('impact.usersAffected') +
                                  ' ' +
                                  format.integer(service.usersAffected)
                                : ''}
                            </span>
                          </td>
                          <td className="py-om-8 pe-om-10">
                            <Tag variant="state" state={predictedUiState(service.predicted)}>
                              {t(predictedKey[service.predicted])}
                            </Tag>
                          </td>
                          <td
                            className={cx(
                              'py-om-8 pe-om-10 font-om-mono text-om-xs',
                              service.slaBudgetRemainingMinutes !== null &&
                                service.slaBudgetRemainingMinutes <= 0
                                ? 'text-om-rose'
                                : 'text-om-secondary',
                            )}
                          >
                            {service.slaBudgetRemainingMinutes === null
                              ? t('common.none')
                              : t('impact.result.slaMinutes', {
                                  minutes: format.integer(service.slaBudgetRemainingMinutes),
                                })}
                          </td>
                          <td className="py-om-8 text-om-xs text-om-secondary">
                            {service.recovery === null
                              ? t('common.none')
                              : t('impact.result.recoveryMinutes', {
                                  description: service.recovery.description,
                                  minutes: format.integer(service.recovery.estimatedMinutes),
                                })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </Card>
            </>
          )}
        </div>

        {/* End column: assistant and saved scenarios */}
        <div className="flex flex-col gap-om-16">
          <Card as="section" className="flex flex-col gap-om-12 border border-om-violet/30">
            <SectionTitle
              as="h2"
              size="sm"
              action={<Pill variant="violet">{t('impact.assistant.grounded')}</Pill>}
            >
              {t('impact.step.assistant')}
            </SectionTitle>
            {outcome === undefined ? (
              <p className="text-om-sm text-om-secondary">{t('impact.assistant.idle')}</p>
            ) : (
              <>
                {outcome.simulation.recommendations.length > 0 ? (
                  <section className="flex flex-col gap-om-6">
                    <h3 className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
                      {t('impact.assistant.recommendations')}
                    </h3>
                    <ol className="flex flex-col gap-om-6">
                      {outcome.simulation.recommendations.map((rec, index) => (
                        <li
                          key={rec.title}
                          className="flex items-start gap-om-10 rounded-om-panel border border-om-border-glass bg-om-surface2/60 px-om-10 py-om-8"
                        >
                          <span className="grid size-6 shrink-0 place-items-center rounded-om-pill bg-om-violet/20 font-om-display text-om-xs font-bold text-om-violet-light">
                            {format.integer(index + 1)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-om-sm font-medium text-om-primary">{rec.title}</span>
                            <span className="block text-om-xs text-om-secondary">{rec.rationale}</span>
                          </span>
                          {rec.estimatedMinutes !== null ? (
                            <Tag>
                              {t('impact.assistant.estimated', {
                                minutes: format.integer(rec.estimatedMinutes),
                              })}
                            </Tag>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  </section>
                ) : null}
                <AssistantAnswerBlock
                  locale={locale}
                  pending={assistant.isPending}
                  error={assistant.isError}
                  answer={assistant.data}
                />
              </>
            )}
          </Card>

          <Card as="section" className="flex flex-col gap-om-12">
            <SectionTitle as="h2" size="sm">
              {t('impact.step.saved')}
            </SectionTitle>
            {scenarios.isPending ? (
              <QueryState status="pending" />
            ) : scenarios.isError ? (
              <QueryState
                status="error"
                onRetry={() => {
                  void scenarios.refetch();
                }}
              />
            ) : scenarios.data.length === 0 ? (
              <p className="text-om-sm text-om-secondary">{t('impact.saved.empty')}</p>
            ) : (
              <ul className="flex flex-col gap-om-6">
                {scenarios.data.map((scenario) => (
                  <li
                    key={scenario.id}
                    className="flex items-center gap-om-10 rounded-om-panel border border-om-border-glass bg-om-surface2/60 px-om-10 py-om-8 text-om-sm"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-om-primary">{scenario.name}</span>
                      <span className="block truncate text-om-2xs text-om-muted">
                        {t('impact.saved.by', {
                          by: scenario.createdBy,
                          when: format.dateTime(scenario.createdAt),
                        })}{' '}
                        · {t('impact.saved.components', { count: format.integer(scenario.failedCis.length) })}
                      </span>
                    </span>
                    <Pill
                      variant="primary"
                      glowing={false}
                      icon={<Icon name="play" className="size-3" />}
                      onClick={() => {
                        rerun.mutate(scenario);
                      }}
                    >
                      {t('impact.saved.run')}
                    </Pill>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
      <ImpactAccuracyPanel locale={locale} />
    </div>
  );
}

function AssistantAnswerBlock({
  locale,
  pending,
  error,
  answer,
}: {
  locale: Locale;
  pending: boolean;
  error: boolean;
  answer: AssistantAnswer | undefined;
}): ReactNode {
  const t = useT();
  const format = useFormatters();
  if (pending) return <QueryState status="pending" />;
  if (error) {
    return (
      <p role="alert" className="text-om-sm text-om-rose">
        {t('impact.assistant.error')}
      </p>
    );
  }
  if (answer === undefined)
    return <p className="text-om-sm text-om-secondary">{t('impact.assistant.pending')}</p>;
  return (
    <div className="flex flex-col gap-om-10">
      <p className="text-om-sm text-om-primary">{answer.text}</p>
      {answer.cis.length > 0 ? (
        <section className="flex flex-col gap-om-4">
          <h3 className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
            {t('impact.assistant.grounding', { count: format.integer(answer.cis.length) })}
          </h3>
          <ul className="flex flex-wrap gap-om-6">
            {answer.cis.map((ci) => (
              <li key={ci.id}>
                <Link
                  href={ciHref(locale, ci)}
                  className="flex items-center gap-om-6 rounded-om-tag border border-om-border-glass bg-om-surface2 px-om-8 py-om-4 text-om-xs text-om-primary hover:border-om-cyan/40"
                >
                  <StateBadge state={ci.health} label={t(healthKey[ci.health])} />
                  {ci.displayName}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {answer.cypher !== '' ? (
        <section className="flex flex-col gap-om-4">
          <h3 className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
            {t('impact.assistant.cypher')}
          </h3>
          <pre className="overflow-x-auto rounded-om-panel border border-om-border-glass bg-om-ground/60 p-om-10 font-om-mono text-om-2xs text-om-violet-light">
            {answer.cypher}
          </pre>
        </section>
      ) : null}
    </div>
  );
}
