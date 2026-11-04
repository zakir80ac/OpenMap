'use client';
// REQ-UI-030 — the dashboard wizard (ADR-020): pick a persona template (Admin, CTO/CIO, CISO, Finance, or start
// from scratch), tick the widgets and their sizes, name and share it, create. Every step is real state; Create
// writes through createDashboard and the view opens the result.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DASHBOARD } from '@openmap/constants';
import { DASHBOARD_PERSONAS, WIDGET_SIZES, templateWidgets, type DashboardPersona, type DashboardWidgetInput, type WidgetKind, type WidgetSize } from '@openmap/contracts';
import type { MessageKey } from '@openmap/i18n';
import { Card, Pill, SectionTitle, Segmented, Tag, cx } from '@openmap/ui';
import { useId, useState, type ReactNode } from 'react';
import { Button, Field, TextInput } from '@/components/common/controls';
import { Icon, type IconName } from '@/components/icons';
import { createDashboard, dashboardsQueryKey, type Dashboard } from '@/lib/dashboard-queries';
import { useFormatters, useT } from '@/providers';
import { WIDGET_AREAS, WIDGET_REGISTRY, areaKey, widgetDescriptionKey, widgetTitleKey } from './widgets';

export interface DashboardWizardProps {
  /** Called with the created dashboard; the view selects it. */
  onCreated: (dashboard: Dashboard) => void;
  /** Present when other dashboards exist, so the wizard can be left. */
  onCancel: (() => void) | null;
}

const STEPS = ['persona', 'widgets', 'details'] as const;
type Step = (typeof STEPS)[number];

export function personaKey(persona: DashboardPersona): MessageKey {
  return `dashboard.persona.${persona}.title`;
}
export function personaDescriptionKey(persona: DashboardPersona): MessageKey {
  return `dashboard.persona.${persona}.desc`;
}

const PERSONA_ICON: Record<DashboardPersona, IconName> = {
  admin: 'settings',
  cto_cio: 'analytics',
  ciso: 'shield',
  finance: 'tag',
  custom: 'dashboard',
};

export function stepKey(step: Step): MessageKey {
  return `dashboard.wizard.step.${step}`;
}

export function DashboardWizard({ onCreated, onCancel }: DashboardWizardProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const queryClient = useQueryClient();
  const nameId = useId();
  const [step, setStep] = useState<Step>('persona');
  const [persona, setPersona] = useState<DashboardPersona>('cto_cio');
  const [widgets, setWidgets] = useState<DashboardWidgetInput[]>(() => templateWidgets('cto_cio'));
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);

  const create = useMutation({
    mutationFn: createDashboard,
    onSuccess: (dashboard) => {
      void queryClient.invalidateQueries({ queryKey: dashboardsQueryKey });
      onCreated(dashboard);
    },
  });

  const choosePersona = (p: DashboardPersona): void => {
    setPersona(p);
    setWidgets(templateWidgets(p));
  };
  const has = (kind: WidgetKind): boolean => widgets.some((w) => w.kind === kind);
  const toggle = (kind: WidgetKind, size: WidgetSize): void => {
    setWidgets((list) => (list.some((w) => w.kind === kind) ? list.filter((w) => w.kind !== kind) : list.length >= DASHBOARD.maxWidgets ? list : [...list, { kind, size, options: {} }]));
  };
  const resize = (kind: WidgetKind, size: WidgetSize): void => {
    setWidgets((list) => list.map((w) => (w.kind === kind ? { ...w, size } : w)));
  };
  const effectiveName = name.trim() === '' ? t(personaKey(persona)) : name.trim();
  const index = STEPS.indexOf(step);
  const canContinue = step === 'widgets' ? widgets.length > 0 : true;

  const submit = (): void => {
    create.mutate({ name: effectiveName, persona, shared, widgets });
  };

  return (
    <section aria-label={t('dashboard.wizard.title')} className="flex flex-col gap-om-16">
      <Card as="section" className="flex flex-col gap-om-16">
        <SectionTitle size="md" eyebrow={t('dashboard.wizard.eyebrow')} description={t('dashboard.wizard.subtitle')}>
          {t('dashboard.wizard.title')}
        </SectionTitle>
        <ol aria-label={t('dashboard.wizard.steps')} className="flex flex-wrap items-center gap-om-8">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={s === step ? 'step' : undefined}>
              <Pill variant={s === step ? 'primary' : i < index ? 'violet' : 'default'} selected={s === step}>
                {format.integer(i + 1)} · {t(stepKey(s))}
              </Pill>
            </li>
          ))}
        </ol>

        {step === 'persona' ? (
          <ul aria-label={t('dashboard.wizard.step.persona')} className="grid grid-cols-1 gap-om-12 sm:grid-cols-2 xl:grid-cols-5">
            {DASHBOARD_PERSONAS.map((p) => {
              const active = p === persona;
              return (
                <li key={p}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => {
                      choosePersona(p);
                    }}
                    className={cx(
                      'om-float flex h-full w-full flex-col gap-om-8 rounded-om-panel border p-om-14 text-start transition-colors duration-om-fast',
                      active ? 'border-om-cyan/50 bg-om-cyan/10 shadow-om-glow-bar-cyan' : 'border-om-border-glass bg-om-surface2/60 hover:bg-om-surface3/60',
                    )}
                  >
                    <span className={cx('flex size-9 items-center justify-center rounded-om-pill text-om-lg', active ? 'bg-om-cyan/20 text-om-cyan' : 'bg-om-violet/15 text-om-violet')}>
                      <Icon name={PERSONA_ICON[p]} />
                    </span>
                    <span className="font-om-display text-om-md font-bold text-om-primary">{t(personaKey(p))}</span>
                    <span className="text-om-xs text-om-secondary">{t(personaDescriptionKey(p))}</span>
                    <span className="mt-auto font-om-mono text-om-2xs text-om-muted">{t('dashboard.wizard.widgetCount', { count: format.integer(templateWidgets(p).length) })}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        {step === 'widgets' ? (
          <div className="flex flex-col gap-om-12">
            <p className="text-om-sm text-om-secondary">{t('dashboard.wizard.widgetsHint', { selected: format.integer(widgets.length), max: format.integer(DASHBOARD.maxWidgets) })}</p>
            {WIDGET_AREAS.map((area) => (
              <section key={area} aria-label={t(areaKey(area))} className="flex flex-col gap-om-6">
                <h3 className="font-om-mono text-om-2xs uppercase tracking-[0.1em] text-om-cyan">{t(areaKey(area))}</h3>
                <ul className="grid grid-cols-1 gap-om-6 md:grid-cols-2">
                  {WIDGET_REGISTRY.filter((spec) => spec.area === area).map((spec) => {
                    const on = has(spec.kind);
                    const current = widgets.find((w) => w.kind === spec.kind)?.size ?? spec.defaultSize;
                    return (
                      <li key={spec.kind} className={cx('flex items-start gap-om-10 rounded-om-panel border p-om-10', on ? 'border-om-cyan/40 bg-om-cyan/5' : 'border-om-border-glass bg-om-surface2/40')}>
                        <input
                          id={'w-' + spec.kind}
                          type="checkbox"
                          checked={on}
                          onChange={() => {
                            toggle(spec.kind, spec.defaultSize);
                          }}
                          className="mt-om-4 accent-om-cyan"
                        />
                        <label htmlFor={'w-' + spec.kind} className="flex min-w-0 flex-1 flex-col gap-om-2">
                          <span className="flex items-center gap-om-6 text-om-sm font-medium text-om-primary">
                            <Icon name={spec.icon} className="text-om-cyan" />
                            {t(widgetTitleKey(spec.kind))}
                          </span>
                          <span className="text-om-xs text-om-secondary">{t(widgetDescriptionKey(spec.kind))}</span>
                        </label>
                        {on ? (
                          <Segmented
                            label={t('dashboard.size.label')}
                            value={current}
                            onChange={(size) => {
                              resize(spec.kind, size);
                            }}
                            options={WIDGET_SIZES.map((size) => ({ value: size, label: t(`dashboard.size.${size}`) }))}
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        ) : null}

        {step === 'details' ? (
          <div className="grid grid-cols-1 gap-om-16 md:grid-cols-2">
            <div className="flex flex-col gap-om-12">
              <Field id={nameId} label={t('dashboard.wizard.name')} hint={t('dashboard.wizard.nameHint')}>
                <TextInput
                  id={nameId}
                  value={name}
                  maxLength={DASHBOARD.nameMaxChars}
                  onChange={(e) => {
                    setName(e.target.value);
                  }}
                />
              </Field>
              <label className="flex items-center gap-om-8 text-om-sm text-om-primary">
                <input
                  type="checkbox"
                  checked={shared}
                  onChange={(e) => {
                    setShared(e.target.checked);
                  }}
                  className="accent-om-cyan"
                />
                {t('dashboard.wizard.shared')}
              </label>
              <p className="text-om-xs text-om-secondary">{t('dashboard.wizard.sharedHint')}</p>
            </div>
            <div className="flex flex-col gap-om-8 rounded-om-panel border border-om-border-glass bg-om-surface2/50 p-om-12">
              <span className="font-om-mono text-om-2xs uppercase tracking-[0.1em] text-om-cyan">{t('dashboard.wizard.summary')}</span>
              <span className="font-om-display text-om-lg font-bold text-om-primary">{effectiveName}</span>
              <span className="text-om-xs text-om-secondary">{t(personaKey(persona))} · {t('dashboard.wizard.widgetCount', { count: format.integer(widgets.length) })}</span>
              <ul className="flex flex-wrap gap-om-4">
                {widgets.map((w) => (
                  <li key={w.kind}>
                    <Tag variant="neutral">{t(widgetTitleKey(w.kind))}</Tag>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        {create.isError ? (
          <p role="alert" className="text-om-sm text-om-rose">
            {t('common.error')} · {create.error.message}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-om-8 border-t border-om-border-glass pt-om-12">
          <div className="flex gap-om-8">
            {onCancel !== null ? (
              <Button tone="quiet" onClick={onCancel}>
                {t('common.cancel')}
              </Button>
            ) : null}
            {index > 0 ? (
              <Button
                tone="quiet"
                onClick={() => {
                  setStep(STEPS[index - 1] ?? 'persona');
                }}
              >
                {t('common.back')}
              </Button>
            ) : null}
          </div>
          {step === 'details' ? (
            <Button onClick={submit} disabled={create.isPending || widgets.length === 0}>
              {create.isPending ? t('common.saving') : t('dashboard.wizard.create')}
            </Button>
          ) : (
            <Button
              onClick={() => {
                setStep(STEPS[index + 1] ?? 'details');
              }}
              disabled={!canContinue}
            >
              {t('common.next')}
            </Button>
          )}
        </div>
      </Card>
    </section>
  );
}
