'use client';
// REQ-UI-024 — step 2: sites. Saving one creates (or updates) its site CI; removing one retires the CI.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SETUP_LIMITS } from '@openmap/constants';
import { SITE_KINDS } from '@openmap/contracts';
import { Tag } from '@openmap/ui';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { onboardingQueryKey, removeSite, upsertSite, type Site, type SiteInput, type SiteKind } from '@/lib/setup-queries';
import { useFormatters, useT } from '@/providers';
import { DANGER_BUTTON, MutationError, numberOrNull, PRIMARY_BUTTON, SECONDARY_BUTTON, SelectInput, StepCard, TABLE_HEAD, TextInput } from './fields';
import { StepActions, type StepProps } from './SetupView';

const CLOUD_PROVIDERS = ['azure', 'aws', 'gcp', 'oci', 'other'] as const;
const TIERS = ['1', '2', '3', '4'] as const;

interface Draft {
  code: string;
  name: string;
  kind: SiteKind;
  tier: string;
  address: string;
  city: string;
  countryCode: string;
  lat: string;
  lon: string;
  cloudProvider: string;
  cloudRegion: string;
  locationCount: string;
  powerCapacityKw: string;
  rackCount: string;
  designPue: string;
}

const EMPTY: Draft = { code: '', name: '', kind: SITE_KINDS[0], tier: '', address: '', city: '', countryCode: '', lat: '', lon: '', cloudProvider: CLOUD_PROVIDERS[0], cloudRegion: '', locationCount: '1', powerCapacityKw: '', rackCount: '', designPue: '' };

function draftOf(site: Site): Draft {
  return {
    code: site.code,
    name: site.name,
    kind: site.kind,
    tier: site.tier === null ? '' : String(site.tier),
    address: site.address,
    city: site.city,
    countryCode: site.countryCode,
    lat: site.geo === null ? '' : String(site.geo.lat),
    lon: site.geo === null ? '' : String(site.geo.lon),
    cloudProvider: site.cloud?.provider ?? CLOUD_PROVIDERS[0],
    cloudRegion: site.cloud?.region ?? '',
    locationCount: String(site.locationCount),
    powerCapacityKw: site.facility === null ? '' : String(site.facility.powerCapacityKw),
    rackCount: site.facility === null ? '' : String(site.facility.rackCount),
    designPue: site.facility?.designPue === null || site.facility === null ? '' : String(site.facility.designPue),
  };
}

export function toSiteInput(draft: Draft): SiteInput {
  const lat = numberOrNull(draft.lat);
  const lon = numberOrNull(draft.lon);
  const power = numberOrNull(draft.powerCapacityKw);
  const racks = numberOrNull(draft.rackCount);
  const cloud = draft.kind === 'cloud_region';
  return {
    code: draft.code.trim().toUpperCase(),
    name: draft.name.trim(),
    kind: draft.kind,
    tier: numberOrNull(draft.tier),
    address: draft.address.trim(),
    city: draft.city.trim(),
    countryCode: draft.countryCode.trim().toUpperCase(),
    geo: lat !== null && lon !== null ? { lat, lon } : null,
    cloud: cloud ? { provider: draft.cloudProvider, region: draft.cloudRegion.trim() } : null,
    locationCount: numberOrNull(draft.locationCount) ?? 1,
    facility: !cloud && power !== null && racks !== null ? { powerCapacityKw: power, rackCount: racks, designPue: numberOrNull(draft.designPue) } : null,
  };
}

export function SitesStep({ state, editable, onContinue, onBack, continuing }: StepProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Site | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [open, setOpen] = useState(state.sites.length === 0);
  const save = useMutation({
    mutationFn: (input: SiteInput) => upsertSite(editing?.id ?? null, input),
    onSuccess: async () => {
      setDraft(EMPTY);
      setEditing(null);
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: onboardingQueryKey });
    },
  });
  const remove = useMutation({
    mutationFn: removeSite,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: onboardingQueryKey });
    },
  });
  const update = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const valid = draft.code.trim() !== '' && draft.name.trim() !== '' && draft.city.trim() !== '' && draft.countryCode.trim().length === SETUP_LIMITS.countryCodeLength && (draft.kind !== 'cloud_region' || draft.cloudRegion.trim() !== '');
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!editable || !valid) return;
    save.mutate(toSiteInput(draft));
  };
  const kindLabel = (kind: SiteKind): string => t(`setup.sites.kind.${kind}`);
  const isCloud = draft.kind === 'cloud_region';

  return (
    <StepCard
      title={t('setup.sites.title')}
      description={t('setup.sites.subtitle')}
      actions={<StepActions onBack={onBack} onContinue={onContinue} continuing={continuing} continueLabel={t('setup.next')} disabled={state.sites.length === 0} />}
    >
      {state.sites.length === 0 ? (
        <p className="text-om-sm text-om-secondary">{t('setup.sites.empty')}</p>
      ) : (
        <table className="w-full text-om-sm" aria-label={t('setup.sites.title')}>
          <thead>
            <tr className={TABLE_HEAD}>
              <th scope="col" className="py-om-6 text-start">{t('setup.sites.column.code')}</th>
              <th scope="col" className="py-om-6 text-start">{t('setup.sites.column.name')}</th>
              <th scope="col" className="py-om-6 text-start">{t('setup.sites.column.kind')}</th>
              <th scope="col" className="py-om-6 text-start">{t('setup.sites.column.city')}</th>
              <th scope="col" className="py-om-6 text-start">{t('setup.sites.column.nodes')}</th>
              <th scope="col" className="py-om-6 text-start">{t('setup.sites.column.ci')}</th>
              <th scope="col" className="py-om-6 text-end" />
            </tr>
          </thead>
          <tbody>
            {state.sites.map((site) => (
              <tr key={site.id} className="border-t border-om-border-glass">
                <td className="py-om-8 font-om-mono text-om-xs text-om-cyan">{site.code}</td>
                <td className="py-om-8 text-om-primary">{site.name}</td>
                <td className="py-om-8"><Tag>{kindLabel(site.kind)}</Tag></td>
                <td className="py-om-8 text-om-secondary">{site.city + ', ' + site.countryCode}</td>
                <td className="py-om-8 text-om-secondary">{format.integer(site.nodes.length)}</td>
                <td className="py-om-8 font-om-mono text-om-2xs text-om-muted">{site.ci?.code ?? t('common.none')}</td>
                <td className="py-om-8 text-end">
                  <span className="inline-flex gap-om-6">
                    <button type="button" className={SECONDARY_BUTTON} disabled={!editable} onClick={() => { setEditing(site); setDraft(draftOf(site)); setOpen(true); }}>
                      {t('setup.sites.edit')}
                    </button>
                    <button type="button" className={DANGER_BUTTON} disabled={!editable || remove.isPending} onClick={() => { remove.mutate(site.id); }}>
                      {t('setup.sites.remove')}
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <MutationError error={remove.error} />

      {open ? (
        <form onSubmit={onSubmit} aria-label={editing === null ? t('setup.sites.form.title') : t('setup.sites.form.editTitle', { code: editing.code })} className="flex flex-col gap-om-12 rounded-om-panel border border-om-border-glass bg-om-surface2/60 p-om-16">
          <h3 className="text-om-sm font-semibold text-om-primary">{editing === null ? t('setup.sites.form.title') : t('setup.sites.form.editTitle', { code: editing.code })}</h3>
          <div className="grid grid-cols-1 gap-om-12 md:grid-cols-3">
            <TextInput id={id + '-code'} label={t('setup.sites.code')} hint={t('setup.sites.codeHint')} value={draft.code} required disabled={!editable || editing !== null} onChange={(e) => { update('code', e.target.value.toUpperCase()); }} />
            <TextInput id={id + '-name'} label={t('setup.sites.name')} value={draft.name} required disabled={!editable} onChange={(e) => { update('name', e.target.value); }} />
            <SelectInput id={id + '-kind'} label={t('setup.sites.kind')} value={draft.kind} disabled={!editable} onChange={(e) => { update('kind', e.target.value as SiteKind); }}>
              {SITE_KINDS.map((kind) => (
                <option key={kind} value={kind}>{kindLabel(kind)}</option>
              ))}
            </SelectInput>
            <TextInput id={id + '-address'} label={t('setup.sites.address')} value={draft.address} disabled={!editable} onChange={(e) => { update('address', e.target.value); }} />
            <TextInput id={id + '-city'} label={t('setup.sites.city')} value={draft.city} required disabled={!editable} onChange={(e) => { update('city', e.target.value); }} />
            <TextInput id={id + '-country'} label={t('setup.sites.country')} value={draft.countryCode} required maxLength={SETUP_LIMITS.countryCodeLength} disabled={!editable} onChange={(e) => { update('countryCode', e.target.value.toUpperCase()); }} />
            <TextInput id={id + '-lat'} label={t('setup.sites.lat')} inputMode="decimal" value={draft.lat} disabled={!editable} onChange={(e) => { update('lat', e.target.value); }} />
            <TextInput id={id + '-lon'} label={t('setup.sites.lon')} inputMode="decimal" value={draft.lon} disabled={!editable} onChange={(e) => { update('lon', e.target.value); }} />
            <TextInput id={id + '-locations'} label={t('setup.sites.locationCount')} inputMode="numeric" value={draft.locationCount} disabled={!editable} onChange={(e) => { update('locationCount', e.target.value); }} />
            {isCloud ? (
              <>
                <SelectInput id={id + '-provider'} label={t('setup.sites.cloudProvider')} value={draft.cloudProvider} disabled={!editable} onChange={(e) => { update('cloudProvider', e.target.value); }}>
                  {CLOUD_PROVIDERS.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </SelectInput>
                <TextInput id={id + '-region'} label={t('setup.sites.cloudRegion')} value={draft.cloudRegion} required disabled={!editable} onChange={(e) => { update('cloudRegion', e.target.value); }} />
              </>
            ) : (
              <>
                <SelectInput id={id + '-tier'} label={t('setup.sites.tier')} value={draft.tier} disabled={!editable} onChange={(e) => { update('tier', e.target.value); }}>
                  <option value="">{t('setup.sites.tier.none')}</option>
                  {TIERS.map((tier) => (
                    <option key={tier} value={tier}>{tier}</option>
                  ))}
                </SelectInput>
                <TextInput id={id + '-power'} label={t('setup.sites.powerKw')} inputMode="decimal" value={draft.powerCapacityKw} disabled={!editable} onChange={(e) => { update('powerCapacityKw', e.target.value); }} />
                <TextInput id={id + '-racks'} label={t('setup.sites.racks')} inputMode="numeric" value={draft.rackCount} disabled={!editable} onChange={(e) => { update('rackCount', e.target.value); }} />
                <TextInput id={id + '-pue'} label={t('setup.sites.pue')} inputMode="decimal" value={draft.designPue} disabled={!editable} onChange={(e) => { update('designPue', e.target.value); }} />
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-om-12">
            <button type="submit" className={PRIMARY_BUTTON} disabled={!editable || !valid || save.isPending}>
              {t('setup.sites.save')}
            </button>
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { setOpen(false); setEditing(null); setDraft(EMPTY); }}>
              {t('action.cancel')}
            </button>
            <MutationError error={save.error} />
          </div>
        </form>
      ) : (
        <div>
          <button type="button" className={SECONDARY_BUTTON} disabled={!editable} onClick={() => { setOpen(true); }}>
            {t('setup.sites.add')}
          </button>
        </div>
      )}
    </StepCard>
  );
}
