'use client';
// REQ-UI-024 — step 6: generate the digital twin. Shows what the five steps produced, runs generateTwin, then
// follows the first sweep while it runs.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bar, Kpi, Tag, accents } from '@openmap/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { localizedHref } from '@/lib/locale-path';
import { generateTwin, onboardingQueryKey } from '@/lib/setup-queries';
import { useFormatters, useT } from '@/providers';
import { MutationError, PRIMARY_BUTTON, SECONDARY_BUTTON, StepCard } from './fields';
import { StepActions, type StepProps } from './SetupView';

export function GenerateStep({ state, editable, locale, onBack, continuing }: StepProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const queryClient = useQueryClient();
  const generate = useMutation({
    mutationFn: generateTwin,
    onSuccess: async (next) => {
      queryClient.setQueryData(onboardingQueryKey, { onboarding: next });
      await queryClient.invalidateQueries({ queryKey: ['layers'] });
    },
  });
  const enrolled = state.nodes.filter((n) => n.status !== 'pending').length;
  const sweep = state.firstSweep;
  const running = sweep !== null && sweep.finishedAt === null;

  return (
    <StepCard
      title={t('setup.generate.title')}
      description={t('setup.generate.subtitle')}
      actions={<StepActions onBack={onBack} onContinue={null} continuing={continuing} continueLabel={t('setup.next')} />}
    >
      <div className="grid grid-cols-2 gap-om-12 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label={t('setup.step.sites')} value={format.integer(state.sites.length)} accent={accents.cyan} />
        <Kpi label={t('setup.step.connectivity')} value={format.integer(state.links.length)} />
        <Kpi label={t('setup.nodes.title')} value={format.integer(state.nodes.length)} unit={t('setup.generate.enrolled', { count: format.integer(enrolled) })} />
        <Kpi label={t('setup.credentials.title')} value={format.integer(state.credentials.length)} />
        <Kpi label={t('setup.scopes.title')} value={format.integer(state.scopes.length)} />
        <Kpi label={t('setup.step.integrations')} value={format.integer(state.integrations.length)} />
      </div>

      <div className="flex flex-wrap items-center gap-om-12">
        <button type="button" className={PRIMARY_BUTTON} disabled={!editable || generate.isPending || state.sites.length === 0} onClick={() => { generate.mutate(); }}>
          {state.generatedAt === null ? t('setup.generate.run') : t('setup.generate.rerun')}
        </button>
        {state.generatedAt === null ? (
          <span className="text-om-xs text-om-muted">{t('setup.generate.notYet')}</span>
        ) : (
          <span role="status" className="text-om-xs text-om-emerald">{t('setup.generate.generatedAt', { when: format.dateTime(state.generatedAt) })}</span>
        )}
        <MutationError error={generate.error} />
      </div>

      {sweep === null ? null : (
        <section aria-label={t('setup.generate.sweep')} className="flex flex-col gap-om-10 rounded-om-panel border border-om-border-glass bg-om-surface2/60 p-om-16">
          <div className="flex flex-wrap items-center gap-om-10 text-om-sm">
            <span className="font-om-display text-om-xl font-extrabold text-om-primary">
              {t('discovery.sweep.progress', { done: format.integer(sweep.targetsDone), total: format.integer(sweep.targetsTotal) })}
            </span>
            <Tag>{t('discovery.sweep.devices', { count: format.integer(sweep.devicesDiscovered) })}</Tag>
            <Tag variant="state" state={running ? 'degraded' : 'healthy'}>{running ? t('setup.generate.sweepRunning') : t('setup.generate.sweepDone')}</Tag>
          </div>
          <Bar value={sweep.targetsDone} max={Math.max(sweep.targetsTotal, 1)} label={t('discovery.sweep.label')} accent={running ? accents.cyan : accents.emerald} />
          {enrolled === 0 ? <p className="text-om-2xs text-om-muted">{t('setup.generate.noNodes')}</p> : null}
        </section>
      )}

      {state.generatedAt === null ? null : (
        <div className="flex flex-wrap gap-om-8">
          <Link href={localizedHref(locale, '/discovery')} className={SECONDARY_BUTTON}>
            {t('setup.generate.openDiscovery')}
          </Link>
          <Link href={localizedHref(locale, '/dashboard')} className={SECONDARY_BUTTON}>
            {t('setup.generate.openDashboard')}
          </Link>
        </div>
      )}
    </StepCard>
  );
}
