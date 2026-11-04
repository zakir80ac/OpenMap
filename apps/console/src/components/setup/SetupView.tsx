'use client';
// REQ-UI-020 REQ-UI-024 — the initial setup wizard (ADR-017): six steps over the `onboarding` state, each a real
// write through the setup mutations. Steps can be revisited in any order; the stepper marks the ones completed.
// Administrators change things; every other role reads the same screen.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ONBOARDING_STEPS } from '@openmap/contracts';
import { ROLES } from '@openmap/constants';
import { Pill, SectionTitle, cx } from '@openmap/ui';
import type { Locale } from '@openmap/i18n';
import { useEffect, useState, type ReactNode } from 'react';
import { QueryState } from '@/components/common/QueryState';
import { Icon } from '@/components/icons';
import { useCan } from '@/lib/auth';
import { onboardingQuery, onboardingQueryKey, setOnboardingStep, type OnboardingState, type OnboardingStep } from '@/lib/setup-queries';
import { useT } from '@/providers';
import { ConnectivityStep } from './ConnectivityStep';
import { GenerateStep } from './GenerateStep';
import { IntegrationsStep } from './IntegrationsStep';
import { NodesCredentialsStep } from './NodesCredentialsStep';
import { OrganizationStep } from './OrganizationStep';
import { SitesStep } from './SitesStep';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from './fields';

export interface SetupViewProps {
  locale: Locale;
}

export interface StepProps {
  state: OnboardingState;
  editable: boolean;
  locale: Locale;
  /** Marks the step complete on the server and moves to the next one. */
  onContinue: () => void;
  onBack: (() => void) | null;
  continuing: boolean;
}

export function stepKey(step: OnboardingStep): `setup.step.${OnboardingStep}` {
  return `setup.step.${step}`;
}

export function SetupView({ locale }: SetupViewProps): ReactNode {
  const t = useT();
  const can = useCan();
  const editable = can(ROLES.admin);
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState<OnboardingStep | null>(null);
  const [live, setLive] = useState(false);
  const onboarding = useQuery(onboardingQuery(live));
  const sweepRunning = onboarding.data?.firstSweep !== null && onboarding.data?.firstSweep !== undefined && onboarding.data.firstSweep.finishedAt === null;

  useEffect(() => {
    setLive(sweepRunning);
  }, [sweepRunning]);

  const step: OnboardingStep = current ?? onboarding.data?.step ?? ONBOARDING_STEPS[0];
  const index = ONBOARDING_STEPS.indexOf(step);
  const next = ONBOARDING_STEPS[index + 1];
  const previous = index > 0 ? ONBOARDING_STEPS[index - 1] : undefined;

  const advance = useMutation({
    mutationFn: ({ from, completed }: { from: OnboardingStep; completed: boolean }) => setOnboardingStep(from, completed),
    onSuccess: (state) => {
      queryClient.setQueryData(onboardingQueryKey, { onboarding: state });
    },
  });

  const onContinue = (): void => {
    if (next === undefined) return;
    if (editable) {
      advance.mutate({ from: step, completed: true });
    }
    setCurrent(next);
  };

  return (
    <div className="flex flex-col gap-om-20">
      <SectionTitle as="h1" size="lg" eyebrow={t('app.name')} description={t('setup.subtitle')}>
        {t('setup.title')}
      </SectionTitle>
      {editable ? null : <p className="text-om-sm text-om-secondary">{t('setup.readOnly')}</p>}

      <ol aria-label={t('setup.steps.label')} className="flex flex-wrap items-center gap-om-8">
        {ONBOARDING_STEPS.map((s, i) => {
          const done = onboarding.data?.completedSteps.includes(s) ?? false;
          const active = s === step;
          return (
            <li key={s} aria-current={active ? 'step' : undefined}>
              <Pill
                variant={active ? 'primary' : done ? 'violet' : 'default'}
                selected={active}
                glowing={active}
                icon={done ? <Icon name="check" className="size-3" /> : <span className="font-om-mono text-om-2xs">{String(i + 1)}</span>}
                onClick={() => {
                  setCurrent(s);
                }}
              >
                {t(stepKey(s))}
              </Pill>
            </li>
          );
        })}
      </ol>

      {onboarding.isPending ? (
        <QueryState status="pending" />
      ) : onboarding.isError ? (
        <QueryState
          status="error"
          onRetry={() => {
            void onboarding.refetch();
          }}
        />
      ) : (
        <StepBody
          step={step}
          state={onboarding.data}
          editable={editable}
          locale={locale}
          onContinue={onContinue}
          onBack={previous === undefined ? null : () => { setCurrent(previous); }}
          continuing={advance.isPending}
        />
      )}
    </div>
  );
}

function StepBody({ step, ...props }: StepProps & { step: OnboardingStep }): ReactNode {
  switch (step) {
    case 'organization':
      return <OrganizationStep {...props} />;
    case 'sites':
      return <SitesStep {...props} />;
    case 'connectivity':
      return <ConnectivityStep {...props} />;
    case 'nodes_credentials':
      return <NodesCredentialsStep {...props} />;
    case 'integrations':
      return <IntegrationsStep {...props} />;
    case 'generate':
      return <GenerateStep {...props} />;
  }
}

/** Footer shared by the steps: back on the start side, continue on the end side. */
export function StepActions({ onBack, onContinue, continuing, continueLabel, disabled = false }: { onBack: (() => void) | null; onContinue: (() => void) | null; continuing: boolean; continueLabel: string; disabled?: boolean }): ReactNode {
  const t = useT();
  return (
    <>
      {onBack === null ? <span /> : (
        <button type="button" className={SECONDARY_BUTTON} onClick={onBack}>
          {t('setup.back')}
        </button>
      )}
      {onContinue === null ? null : (
        <button type="button" className={cx(PRIMARY_BUTTON)} onClick={onContinue} disabled={continuing || disabled}>
          {continueLabel}
        </button>
      )}
    </>
  );
}
