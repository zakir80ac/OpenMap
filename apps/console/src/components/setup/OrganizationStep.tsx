'use client';
// REQ-UI-024 — step 1: the organization and its business units (tenants).
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LOCALES } from '@openmap/constants';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { onboardingQueryKey, updateOrganization, type OnboardingState, type OrganizationInput } from '@/lib/setup-queries';
import { useT } from '@/providers';
import { DANGER_BUTTON, MutationError, PRIMARY_BUTTON, SECONDARY_BUTTON, SelectInput, StepCard, TextInput } from './fields';
import { StepActions, type StepProps } from './SetupView';

interface UnitDraft {
  tenantId: string | null;
  name: string;
  slug: string | null;
}

interface Draft {
  name: string;
  industry: string;
  timeZone: string;
  defaultLocale: string;
  regulatoryScope: string;
  airGapped: boolean;
  businessUnits: UnitDraft[];
}

function draftOf(state: OnboardingState): Draft {
  const org = state.organization;
  return {
    name: org.name,
    industry: org.industry,
    timeZone: org.timeZone,
    defaultLocale: org.defaultLocale,
    regulatoryScope: org.regulatoryScope.join(', '),
    airGapped: org.airGapped,
    businessUnits: org.businessUnits.map((u) => ({ tenantId: u.tenantId, name: u.name, slug: u.slug })),
  };
}

export function toOrganizationInput(draft: Draft): OrganizationInput {
  return {
    name: draft.name.trim(),
    industry: draft.industry.trim(),
    timeZone: draft.timeZone.trim(),
    defaultLocale: draft.defaultLocale,
    regulatoryScope: draft.regulatoryScope.split(',').map((s) => s.trim()).filter((s) => s !== ''),
    airGapped: draft.airGapped,
    businessUnits: draft.businessUnits.filter((u) => u.name.trim() !== '').map((u) => ({ tenantId: u.tenantId, name: u.name.trim() })),
  };
}

export function OrganizationStep({ state, editable, onContinue, onBack, continuing }: StepProps): ReactNode {
  const t = useT();
  const id = useId();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(state));
  const [saved, setSaved] = useState(false);
  const mutation = useMutation({
    mutationFn: updateOrganization,
    onSuccess: async (organization) => {
      setSaved(true);
      queryClient.setQueryData(onboardingQueryKey, (old: { onboarding: OnboardingState } | undefined) => (old === undefined ? old : { onboarding: { ...old.onboarding, organization } }));
      await queryClient.invalidateQueries({ queryKey: onboardingQueryKey });
    },
  });
  const timeZones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const update = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setSaved(false);
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const updateUnit = (index: number, name: string): void => {
    setSaved(false);
    setDraft((d) => ({ ...d, businessUnits: d.businessUnits.map((u, i) => (i === index ? { ...u, name } : u)) }));
  };
  const valid = draft.name.trim() !== '' && draft.industry.trim() !== '' && draft.timeZone.trim() !== '' && draft.businessUnits.some((u) => u.name.trim() !== '');

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!editable || !valid) return;
    mutation.mutate(toOrganizationInput(draft));
  };

  return (
    <StepCard
      title={t('setup.org.title')}
      description={t('setup.org.subtitle')}
      actions={<StepActions onBack={onBack} onContinue={onContinue} continuing={continuing} continueLabel={t('setup.next')} />}
    >
      <form onSubmit={onSubmit} aria-label={t('setup.org.title')} className="flex flex-col gap-om-16">
        <div className="grid grid-cols-1 gap-om-12 md:grid-cols-2">
          <TextInput id={id + '-name'} label={t('setup.org.name')} value={draft.name} required disabled={!editable} onChange={(e) => { update('name', e.target.value); }} />
          <TextInput id={id + '-industry'} label={t('setup.org.industry')} value={draft.industry} required disabled={!editable} onChange={(e) => { update('industry', e.target.value); }} />
          <TextInput id={id + '-tz'} label={t('setup.org.timeZone')} list={id + '-tzs'} value={draft.timeZone} required disabled={!editable} onChange={(e) => { update('timeZone', e.target.value); }} />
          <datalist id={id + '-tzs'}>
            {timeZones.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
          <SelectInput id={id + '-locale'} label={t('setup.org.locale')} value={draft.defaultLocale} disabled={!editable} onChange={(e) => { update('defaultLocale', e.target.value); }}>
            {LOCALES.map((locale) => (
              <option key={locale} value={locale}>
                {t(locale === 'ar' ? 'setup.org.locale.ar' : 'setup.org.locale.en')}
              </option>
            ))}
          </SelectInput>
          <TextInput id={id + '-reg'} label={t('setup.org.regulatory')} value={draft.regulatoryScope} disabled={!editable} wrapperClassName="md:col-span-2" onChange={(e) => { update('regulatoryScope', e.target.value); }} />
          <label className="flex items-center gap-om-8 text-om-sm text-om-secondary md:col-span-2">
            <input type="checkbox" checked={draft.airGapped} disabled={!editable} onChange={(e) => { update('airGapped', e.target.checked); }} />
            {t('setup.org.airGapped')}
          </label>
        </div>

        <fieldset className="flex flex-col gap-om-8">
          <legend className="text-om-sm font-semibold text-om-primary">{t('setup.org.units')}</legend>
          <p className="text-om-2xs text-om-muted">{t('setup.org.units.hint')}</p>
          {draft.businessUnits.map((unit, index) => (
            <div key={unit.tenantId ?? 'new-' + String(index)} className="flex flex-wrap items-end gap-om-8">
              <TextInput id={id + '-unit-' + String(index)} label={t('setup.org.unit.name')} value={unit.name} disabled={!editable} wrapperClassName="min-w-56 flex-1" onChange={(e) => { updateUnit(index, e.target.value); }} />
              {unit.slug === null ? (
                <button type="button" className={DANGER_BUTTON} disabled={!editable} onClick={() => { setDraft((d) => ({ ...d, businessUnits: d.businessUnits.filter((_, i) => i !== index) })); }}>
                  {t('setup.org.unit.remove')}
                </button>
              ) : (
                <span className="pb-om-8 font-om-mono text-om-2xs text-om-muted">{t('setup.org.unit.slug', { slug: unit.slug })}</span>
              )}
            </div>
          ))}
          <div>
            <button type="button" className={SECONDARY_BUTTON} disabled={!editable} onClick={() => { setDraft((d) => ({ ...d, businessUnits: [...d.businessUnits, { tenantId: null, name: '', slug: null }] })); }}>
              {t('setup.org.unit.add')}
            </button>
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-om-12">
          <button type="submit" className={PRIMARY_BUTTON} disabled={!editable || !valid || mutation.isPending}>
            {t('setup.org.save')}
          </button>
          {saved ? (
            <span role="status" className="text-om-xs text-om-emerald">
              {t('setup.saved')}
            </span>
          ) : null}
          <MutationError error={mutation.error} />
        </div>
      </form>
    </StepCard>
  );
}
