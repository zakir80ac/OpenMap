'use client';
// REQ-UI-004 REQ-UI-030 — Dashboard (ADR-020): the user's dashboards from the `dashboards` query; the first visit
// without one opens the wizard; a dashboard renders its widgets on the four-column grid from live queries; the owner
// customises it in place (add, remove, resize, reorder), shares it, makes it the default or deletes it.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DASHBOARD } from '@openmap/constants';
import { WIDGET_SIZES, type WidgetKind, type WidgetSize } from '@openmap/contracts';
import { Card, Pill, SectionTitle, Segmented, cx } from '@openmap/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { Icon } from '@/components/icons';
import { dashboardsQuery, dashboardsQueryKey, deleteDashboard, estateStatsQuery, setDefaultDashboard, toInput, updateDashboard, type Dashboard, type DashboardWidget } from '@/lib/dashboard-queries';
import { localizedHref } from '@/lib/locale-path';
import { onboardingQuery } from '@/lib/setup-queries';
import { useLocale, useT } from '@/providers';
import { DashboardWizard, personaKey } from './DashboardWizard';
import { SIZE_CLASS, WIDGET_REGISTRY, widgetSpec, widgetTitleKey } from './widgets';

const DASHBOARD_PARAM = 'd';

/** Which dashboard to show: the one in the URL, else the user's default, else the first visible. */
export function pickDashboard(list: readonly Dashboard[], requested: string | null): Dashboard | undefined {
  return list.find((d) => d.id === requested) ?? list.find((d) => d.isDefault && d.mine) ?? list.find((d) => d.mine) ?? list[0];
}

export function moveWidget(list: readonly DashboardWidget[], id: string, delta: number): DashboardWidget[] {
  const index = list.findIndex((w) => w.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= list.length) return [...list];
  const out = [...list];
  const [item] = out.splice(index, 1);
  if (item !== undefined) out.splice(target, 0, item);
  return out;
}

export function DashboardView(): ReactNode {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const dashboards = useQuery(dashboardsQuery());
  const onboarding = useQuery(onboardingQuery());
  const setupPending = onboarding.isSuccess && onboarding.data.generatedAt === null;
  const requested = params.get(DASHBOARD_PARAM);
  const [wizard, setWizard] = useState(false);
  const [draft, setDraft] = useState<DashboardWidget[] | null>(null);
  const [addKind, setAddKind] = useState<WidgetKind | ''>('');

  const list = dashboards.data ?? [];
  const current = useMemo(() => pickDashboard(list, requested), [list, requested]);
  const editing = draft !== null;
  // The aggregate most widgets read: start it with the page so the tiles paint together.
  useQuery({ ...estateStatsQuery(!editing), enabled: current !== undefined });

  const select = (id: string): void => {
    router.replace(localizedHref(locale, '/dashboard') + '?' + new URLSearchParams({ [DASHBOARD_PARAM]: id }).toString());
  };

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: dashboardsQueryKey });
  };
  const save = useMutation({
    mutationFn: ({ id, widgets }: { id: string; widgets: DashboardWidget[] }) => {
      const base = list.find((d) => d.id === id);
      if (base === undefined) throw new Error('dashboard ' + id + ' is not loaded');
      return updateDashboard(id, toInput({ ...base, widgets }));
    },
    onSuccess: () => {
      setDraft(null);
      invalidate();
    },
  });
  const share = useMutation({
    mutationFn: (dashboard: Dashboard) => updateDashboard(dashboard.id, toInput({ ...dashboard, shared: !dashboard.shared })),
    onSuccess: invalidate,
  });
  const makeDefault = useMutation({ mutationFn: setDefaultDashboard, onSuccess: invalidate });
  const remove = useMutation({
    mutationFn: deleteDashboard,
    onSuccess: () => {
      invalidate();
      router.replace(localizedHref(locale, '/dashboard'));
    },
  });

  useEffect(() => {
    setDraft(null);
  }, [current?.id]);

  const heading = (
    <SectionTitle as="h1" size="lg" eyebrow={current !== undefined ? t(personaKey(current.persona)) : t('app.name')} description={t('dashboard.subtitle')}>
      {t('nav.dashboard')}
    </SectionTitle>
  );

  if (dashboards.isPending) {
    return (
      <div className="flex flex-col gap-om-24">
        {heading}
        <QueryState status="pending" />
      </div>
    );
  }
  if (dashboards.isError) {
    return (
      <div className="flex flex-col gap-om-24">
        {heading}
        <QueryState status="error" onRetry={() => void dashboards.refetch()} />
      </div>
    );
  }

  if (wizard || current === undefined) {
    return (
      <div className="flex flex-col gap-om-24">
        {heading}
        {setupPending ? <SetupNudge /> : null}
        <DashboardWizard
          onCreated={(d) => {
            setWizard(false);
            select(d.id);
          }}
          onCancel={
            current === undefined
              ? null
              : () => {
                  setWizard(false);
                }
          }
        />
      </div>
    );
  }

  const widgets = draft ?? current.widgets;
  const present = new Set(widgets.map((w) => w.kind));
  const addable = WIDGET_REGISTRY.filter((spec) => !present.has(spec.kind));

  return (
    <div className="flex flex-col gap-om-20">
      <div className="flex flex-wrap items-end justify-between gap-om-12">
        {heading}
        <div className="flex flex-wrap items-center gap-om-8">
          {list.length > 1 ? (
            <Segmented
              label={t('dashboard.switcher')}
              value={current.id}
              onChange={select}
              options={list.map((d) => ({ value: d.id, label: d.name }))}
            />
          ) : null}
          <Button
            tone="quiet"
            onClick={() => {
              setWizard(true);
            }}
          >
            {t('dashboard.new')}
          </Button>
          {current.mine && !editing ? (
            <Button
              onClick={() => {
                setDraft([...current.widgets]);
              }}
            >
              {t('dashboard.customize')}
            </Button>
          ) : null}
        </div>
      </div>

      {setupPending ? <SetupNudge /> : null}

      {editing ? (
        <Card as="section" padding="12" className="flex flex-wrap items-center gap-om-10" aria-label={t('dashboard.editing')}>
          <span className="font-om-mono text-om-2xs uppercase tracking-[0.1em] text-om-cyan">{t('dashboard.editing')}</span>
          <label className="flex items-center gap-om-6 text-om-xs text-om-secondary">
            {t('dashboard.addWidget')}
            <select
              value={addKind}
              onChange={(e) => {
                setAddKind(e.target.value as WidgetKind | '');
              }}
              className="rounded-om-control border border-om-border-strong bg-om-surface2 px-om-8 py-om-4 text-om-xs text-om-primary"
            >
              <option value="">{t('dashboard.addWidgetPick')}</option>
              {addable.map((spec) => (
                <option key={spec.kind} value={spec.kind}>
                  {t(widgetTitleKey(spec.kind))}
                </option>
              ))}
            </select>
          </label>
          <Button
            tone="quiet"
            disabled={addKind === '' || widgets.length >= DASHBOARD.maxWidgets}
            onClick={() => {
              if (addKind === '') return;
              const spec = widgetSpec(addKind);
              setDraft([...widgets, { id: 'new-' + addKind, kind: addKind, size: spec.defaultSize, options: {} }]);
              setAddKind('');
            }}
          >
            {t('common.add')}
          </Button>
          <span className="ms-auto flex gap-om-8">
            <Pill
              variant={current.shared ? 'violet' : 'default'}
              onClick={() => {
                share.mutate(current);
              }}
            >
              {current.shared ? t('dashboard.sharedOn') : t('dashboard.sharedOff')}
            </Pill>
            {!current.isDefault ? (
              <Pill
                onClick={() => {
                  makeDefault.mutate(current.id);
                }}
              >
                {t('dashboard.makeDefault')}
              </Pill>
            ) : null}
            <Button
              tone="quiet"
              onClick={() => {
                if (window.confirm(t('dashboard.deleteConfirm', { name: current.name }))) remove.mutate(current.id);
              }}
            >
              {t('common.delete')}
            </Button>
            <Button
              tone="quiet"
              onClick={() => {
                setDraft(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              disabled={save.isPending || widgets.length === 0}
              onClick={() => {
                save.mutate({ id: current.id, widgets });
              }}
            >
              {save.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </span>
          {save.isError ? (
            <p role="alert" className="w-full text-om-xs text-om-rose">
              {t('common.error')} · {save.error.message}
            </p>
          ) : null}
        </Card>
      ) : null}

      <section aria-label={t('dashboard.widgets')} className="grid grid-cols-1 gap-om-16 sm:grid-cols-2 xl:grid-cols-4">
        {widgets.map((widget, index) => {
          const spec = widgetSpec(widget.kind);
          const Body = spec.Component;
          return (
            <Card
              key={widget.id}
              as="article"
              padding="16"
              // Cards float when read; while customizing they hold still so the controls stay where the pointer is.
              className={cx('flex min-h-40 flex-col gap-om-10', SIZE_CLASS[widget.size], editing ? 'ring-1 ring-om-cyan/30' : 'om-float')}
              style={{ animationDelay: String(index * DASHBOARD.columns) + 'ms' }}
            >
              <header className="flex flex-wrap items-center gap-om-8">
                <span className="flex size-6 items-center justify-center rounded-om-pill bg-om-cyan/10 text-om-cyan">
                  <Icon name={spec.icon} />
                </span>
                <h2 className="min-w-0 flex-1 truncate font-om-display text-om-sm font-semibold text-om-primary">{t(widgetTitleKey(widget.kind))}</h2>
                {editing ? (
                  <span className="ms-auto flex flex-wrap items-center gap-om-4">
                    <Segmented
                      label={t('dashboard.size.label')}
                      value={widget.size}
                      onChange={(size: WidgetSize) => {
                        setDraft(widgets.map((w) => (w.id === widget.id ? { ...w, size } : w)));
                      }}
                      options={WIDGET_SIZES.map((size) => ({ value: size, label: t(`dashboard.size.${size}`) }))}
                    />
                    <button type="button" aria-label={t('dashboard.moveEarlier')} className="rounded-om-control px-om-6 py-om-2 text-om-secondary hover:text-om-cyan" onClick={() => { setDraft(moveWidget(widgets, widget.id, -1)); }}>
                      <Icon name="arrowLeft" />
                    </button>
                    <button type="button" aria-label={t('dashboard.moveLater')} className="rounded-om-control px-om-6 py-om-2 text-om-secondary hover:text-om-cyan" onClick={() => { setDraft(moveWidget(widgets, widget.id, 1)); }}>
                      <Icon name="arrowRight" />
                    </button>
                    <button type="button" aria-label={t('dashboard.removeWidget')} className="rounded-om-control px-om-6 py-om-2 text-om-secondary hover:text-om-rose" onClick={() => { setDraft(widgets.filter((w) => w.id !== widget.id)); }}>
                      <Icon name="close" />
                    </button>
                  </span>
                ) : (
                  <Link href={localizedHref(locale, spec.href)} className="font-om-mono text-om-2xs uppercase tracking-[0.08em] text-om-cyan hover:underline">
                    {t('common.open')}
                  </Link>
                )}
              </header>
              <div className="min-h-0 flex-1">
                <Body options={widget.options} />
              </div>
            </Card>
          );
        })}
      </section>
    </div>
  );
}

function SetupNudge(): ReactNode {
  const t = useT();
  const locale = useLocale();
  return (
    <Card as="section" padding="16" className="flex flex-wrap items-center justify-between gap-om-12 border-om-cyan/30">
      <div className="flex min-w-0 flex-col gap-om-4">
        <span className="font-om-display text-om-lg font-bold text-om-primary">{t('dashboard.setup.title')}</span>
        <span className="text-om-sm text-om-secondary">{t('dashboard.setup.body')}</span>
      </div>
      <Link href={localizedHref(locale, '/setup')}>
        <Pill variant="primary">{t('dashboard.setup.open')}</Pill>
      </Link>
    </Card>
  );
}
