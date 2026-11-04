'use client';
// REQ-UI-024 — step 5: integrations and seed imports, optional. The editor is the Integrations screen's own form.
import { useQueryClient } from '@tanstack/react-query';
import { Tag } from '@openmap/ui';
import { useState, type ReactNode } from 'react';
import { IntegrationForm } from '@/components/integrations/IntegrationsView';
import { onboardingQueryKey } from '@/lib/setup-queries';
import { useT } from '@/providers';
import { SECONDARY_BUTTON, StepCard } from './fields';
import { StepActions, type StepProps } from './SetupView';

export function IntegrationsStep({ state, editable, onContinue, onBack, continuing }: StepProps): ReactNode {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  return (
    <StepCard
      title={t('setup.integrations.title')}
      description={t('setup.integrations.subtitle')}
      actions={<StepActions onBack={onBack} onContinue={onContinue} continuing={continuing} continueLabel={state.integrations.length === 0 ? t('setup.integrations.skip') : t('setup.next')} />}
    >
      {state.integrations.length === 0 ? (
        <p className="text-om-sm text-om-secondary">{t('setup.integrations.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-om-6">
          {state.integrations.map((integration) => (
            <li key={integration.id} className="flex flex-wrap items-center gap-om-10 rounded-om-panel border border-om-border-glass bg-om-surface2/60 px-om-12 py-om-8 text-om-sm">
              <span className="font-medium text-om-primary">{integration.name}</span>
              <Tag>{integration.vendor}</Tag>
              <Tag>{integration.category}</Tag>
              <span className="text-om-2xs text-om-muted">{integration.direction}</span>
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <IntegrationForm
          existing={null}
          onDone={(saved) => {
            setOpen(false);
            if (saved !== null) void queryClient.invalidateQueries({ queryKey: onboardingQueryKey });
          }}
        />
      ) : (
        <div>
          <button type="button" className={SECONDARY_BUTTON} disabled={!editable} onClick={() => { setOpen(true); }}>
            {t('setup.integrations.add')}
          </button>
        </div>
      )}
    </StepCard>
  );
}
