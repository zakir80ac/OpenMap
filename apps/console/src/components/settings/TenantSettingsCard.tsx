'use client';
// REQ-UI-019 REQ-CORE-012 — tenant settings editor (ADR-011): the defaults every user of the tenant inherits. Every
// signed-in role sees the values; administrators edit and save them through `updateTenantSettings`, which sends only
// the fields that changed. The form resets to the server's copy after each save.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LOCALES, ROLES } from '@openmap/constants';
import { Card, SectionTitle } from '@openmap/ui';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { QueryState } from '@/components/common/QueryState';
import { Icon } from '@/components/icons';
import { useCan } from '@/lib/auth';
import { tenantSettingsQuery, updateTenantSettings, type TenantSettingsPatch, type TenantSettingsView } from '@/lib/queries';
import { useT } from '@/providers';

const NUMBER_FIELDS = ['discoveryIntervalMinutes', 'historyRetentionDays', 'staleAfterDays', 'auditRetentionDays'] as const;
const SWITCH_FIELDS = ['assistantEnabled', 'outboundIntegrationsEnabled'] as const;

/** The fields whose value differs from the server's copy; an empty patch means nothing to save. */
export function diffSettings(current: TenantSettingsView, draft: TenantSettingsView): TenantSettingsPatch {
  const patch: TenantSettingsPatch = {};
  for (const key of Object.keys(draft) as Array<keyof TenantSettingsView>) {
    if (draft[key] !== current[key]) (patch as Record<string, unknown>)[key] = draft[key];
  }
  return patch;
}

export function TenantSettingsCard(): ReactNode {
  const t = useT();
  const can = useCan();
  const settings = useQuery(tenantSettingsQuery());

  return (
    <Card padding="24" className="flex flex-col gap-om-16">
      <SectionTitle as="h2" size="sm" description={t('settings.tenant.subtitle')} action={<Icon name="layers" className="size-5 text-om-violet" />}>
        {t('settings.tenant.title')}
      </SectionTitle>
      {settings.isPending ? (
        <QueryState status="pending" />
      ) : settings.isError ? (
        <QueryState
          status="error"
          onRetry={() => {
            void settings.refetch();
          }}
        />
      ) : (
        <TenantSettingsForm key={JSON.stringify(settings.data)} current={settings.data} editable={can(ROLES.admin)} />
      )}
    </Card>
  );
}

interface TenantSettingsFormProps {
  current: TenantSettingsView;
  editable: boolean;
}

function TenantSettingsForm({ current, editable }: TenantSettingsFormProps): ReactNode {
  const t = useT();
  const idPrefix = useId();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<TenantSettingsView>(current);
  const [saved, setSaved] = useState(false);
  const mutation = useMutation({
    mutationFn: updateTenantSettings,
    onSuccess: async (next) => {
      queryClient.setQueryData(tenantSettingsQuery().queryKey, next);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['layers'] });
    },
  });
  const patch = diffSettings(current, draft);
  const dirty = Object.keys(patch).length > 0;
  const timeZones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!editable || !dirty) return;
    setSaved(false);
    mutation.mutate(patch);
  };
  const update = <K extends keyof TenantSettingsView>(key: K, value: TenantSettingsView[K]): void => {
    setSaved(false);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const fieldClass = 'rounded-om-control border border-om-border-strong bg-om-surface3 px-om-10 py-om-6 text-om-sm text-om-primary disabled:opacity-70';
  const labelClass = 'text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted';

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-om-16" aria-label={t('settings.tenant.title')}>
      <div className="grid grid-cols-1 gap-om-12 md:grid-cols-2">
        <div className="flex flex-col gap-om-4">
          <label htmlFor={idPrefix + '-locale'} className={labelClass}>
            {t('settings.tenant.locale')}
          </label>
          <select
            id={idPrefix + '-locale'}
            value={draft.locale}
            disabled={!editable}
            onChange={(event) => {
              update('locale', event.target.value);
            }}
            className={fieldClass}
          >
            {LOCALES.map((locale) => (
              <option key={locale} value={locale}>
                {t(locale === 'ar' ? 'settings.tenant.locale.ar' : 'settings.tenant.locale.en')}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-om-4">
          <label htmlFor={idPrefix + '-timeZone'} className={labelClass}>
            {t('settings.tenant.timeZone')}
          </label>
          <input
            id={idPrefix + '-timeZone'}
            list={idPrefix + '-timeZones'}
            value={draft.timeZone}
            disabled={!editable}
            required
            onChange={(event) => {
              update('timeZone', event.target.value);
            }}
            className={fieldClass}
          />
          <datalist id={idPrefix + '-timeZones'}>
            {timeZones.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </div>
        {NUMBER_FIELDS.map((key) => (
          <div key={key} className="flex flex-col gap-om-4">
            <label htmlFor={idPrefix + '-' + key} className={labelClass}>
              {t(('settings.tenant.' + key) as Parameters<typeof t>[0])}
            </label>
            <input
              id={idPrefix + '-' + key}
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={draft[key]}
              disabled={!editable}
              required
              onChange={(event) => {
                update(key, Number(event.target.value));
              }}
              className={fieldClass + ' font-om-mono'}
            />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-om-8">
        {SWITCH_FIELDS.map((key) => (
          <label key={key} className="flex items-center gap-om-10 text-om-sm text-om-primary">
            <input
              type="checkbox"
              checked={draft[key]}
              disabled={!editable}
              onChange={(event) => {
                update(key, event.target.checked);
              }}
              className="size-4 accent-om-cyan"
            />
            <span>{t(('settings.tenant.' + key) as Parameters<typeof t>[0])}</span>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-om-12">
        {editable ? (
          <button
            type="submit"
            disabled={!dirty || mutation.isPending}
            className="rounded-om-control border border-om-cyan/30 bg-om-cyan/10 px-om-12 py-om-6 text-om-xs font-medium text-om-cyan transition-colors duration-om-base ease-om-standard hover:bg-om-cyan/20 disabled:opacity-60"
          >
            {mutation.isPending ? t('settings.tenant.saving') : t('settings.tenant.save')}
          </button>
        ) : (
          <p className="text-om-xs text-om-muted">{t('settings.tenant.readOnly')}</p>
        )}
        {saved ? (
          <p role="status" className="text-om-xs text-om-emerald">
            {t('settings.tenant.saved')}
          </p>
        ) : null}
        {mutation.isError ? (
          <p role="alert" className="text-om-xs text-om-rose">
            {t('settings.tenant.error')}
          </p>
        ) : null}
      </div>
    </form>
  );
}
