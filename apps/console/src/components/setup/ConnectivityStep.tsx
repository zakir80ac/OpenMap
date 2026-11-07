'use client';
// REQ-UI-024 — step 3: inter-site links. Saving one creates a site_link CI connected to both site CIs.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LINK_KINDS } from '@openmap/contracts';
import { Tag } from '@openmap/ui';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { onboardingQueryKey, removeSiteLink, upsertSiteLink, type SiteLinkInput } from '@/lib/setup-queries';
import { useFormatters, useT } from '@/providers';
import { DANGER_BUTTON, MutationError, numberOrNull, PRIMARY_BUTTON, SECONDARY_BUTTON, SelectInput, StepCard, TABLE_HEAD, TextInput } from './fields';
import { StepActions, type StepProps } from './SetupView';

const ROLES_OF_LINK = ['primary', 'backup', 'overlay'] as const;
type LinkKind = (typeof LINK_KINDS)[number];
type LinkRole = (typeof ROLES_OF_LINK)[number];

interface Draft {
  fromSiteId: string;
  toSiteId: string;
  kind: LinkKind;
  provider: string;
  circuitId: string;
  bandwidthMbps: string;
  diversePaths: string;
  role: LinkRole;
  latencyMs: string;
  replication: boolean;
  probeTarget: string;
}

export function toLinkInput(draft: Draft): SiteLinkInput {
  return {
    fromSiteId: draft.fromSiteId,
    toSiteId: draft.toSiteId,
    kind: draft.kind,
    provider: draft.provider.trim() === '' ? null : draft.provider.trim(),
    circuitId: draft.circuitId.trim() === '' ? null : draft.circuitId.trim(),
    bandwidthMbps: numberOrNull(draft.bandwidthMbps) ?? 0,
    diversePaths: numberOrNull(draft.diversePaths) ?? 1,
    role: draft.role,
    latencyMs: numberOrNull(draft.latencyMs),
    replication: draft.replication,
    probeTarget: draft.probeTarget.trim() === '' ? null : draft.probeTarget.trim(),
  };
}

export function ConnectivityStep({ state, editable, onContinue, onBack, continuing }: StepProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const queryClient = useQueryClient();
  const first = state.sites[0]?.id ?? '';
  const second = state.sites[1]?.id ?? first;
  const empty: Draft = { fromSiteId: first, toSiteId: second, kind: LINK_KINDS[0], provider: '', circuitId: '', bandwidthMbps: '', diversePaths: '1', role: ROLES_OF_LINK[0], latencyMs: '', replication: false, probeTarget: '' };
  const [draft, setDraft] = useState<Draft>(empty);
  const [open, setOpen] = useState(false);
  const save = useMutation({
    mutationFn: (input: SiteLinkInput) => upsertSiteLink(null, input),
    onSuccess: async () => {
      setDraft(empty);
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: onboardingQueryKey });
    },
  });
  const remove = useMutation({
    mutationFn: removeSiteLink,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: onboardingQueryKey });
    },
  });
  const update = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const bandwidth = numberOrNull(draft.bandwidthMbps);
  const valid = draft.fromSiteId !== '' && draft.toSiteId !== '' && draft.fromSiteId !== draft.toSiteId && bandwidth !== null && bandwidth > 0;
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!editable || !valid) return;
    save.mutate(toLinkInput(draft));
  };
  const kindLabel = (kind: string): string => (LINK_KINDS.includes(kind as LinkKind) ? t(`setup.links.kind.${kind as LinkKind}`) : kind);
  const roleLabel = (role: string): string => (ROLES_OF_LINK.includes(role as LinkRole) ? t(`setup.links.role.${role as LinkRole}`) : role);
  const canLink = state.sites.length > 1;

  return (
    <StepCard
      title={t('setup.links.title')}
      description={t('setup.links.subtitle')}
      actions={<StepActions onBack={onBack} onContinue={onContinue} continuing={continuing} continueLabel={t('setup.next')} />}
    >
      {state.links.length === 0 ? (
        <p className="text-om-sm text-om-secondary">{t('setup.links.empty')}</p>
      ) : (
        <table className="w-full text-om-sm" aria-label={t('setup.links.title')}>
          <thead>
            <tr className={TABLE_HEAD}>
              <th scope="col" className="py-om-6 text-start">{t('setup.links.column.from')}</th>
              <th scope="col" className="py-om-6 text-start">{t('setup.links.column.to')}</th>
              <th scope="col" className="py-om-6 text-start">{t('setup.links.column.kind')}</th>
              <th scope="col" className="py-om-6 text-start">{t('setup.links.column.bandwidth')}</th>
              <th scope="col" className="py-om-6 text-start">{t('setup.links.column.role')}</th>
              <th scope="col" className="py-om-6 text-start">{t('setup.links.column.paths')}</th>
              <th scope="col" className="py-om-6 text-end" />
            </tr>
          </thead>
          <tbody>
            {state.links.map((link) => (
              <tr key={link.id} className="border-t border-om-border-glass">
                <td className="py-om-8 font-om-mono text-om-xs text-om-cyan">{link.fromSite.code}</td>
                <td className="py-om-8 font-om-mono text-om-xs text-om-cyan">{link.toSite.code}</td>
                <td className="py-om-8"><Tag>{kindLabel(link.kind)}</Tag></td>
                <td className="py-om-8 text-om-secondary">{format.integer(link.bandwidthMbps)}</td>
                <td className="py-om-8 text-om-secondary">{roleLabel(link.role)}</td>
                <td className="py-om-8 text-om-secondary">{format.integer(link.diversePaths)}</td>
                <td className="py-om-8 text-end">
                  <button type="button" className={DANGER_BUTTON} disabled={!editable || remove.isPending} onClick={() => { remove.mutate(link.id); }}>
                    {t('setup.links.remove')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <MutationError error={remove.error} />

      {open && canLink ? (
        <form onSubmit={onSubmit} aria-label={t('setup.links.add')} className="flex flex-col gap-om-12 rounded-om-panel border border-om-border-glass bg-om-surface2/60 p-om-16">
          <div className="grid grid-cols-1 gap-om-12 md:grid-cols-3">
            <SelectInput id={id + '-from'} label={t('setup.links.from')} value={draft.fromSiteId} disabled={!editable} onChange={(e) => { update('fromSiteId', e.target.value); }}>
              {state.sites.map((site) => (
                <option key={site.id} value={site.id}>{site.code + ' · ' + site.name}</option>
              ))}
            </SelectInput>
            <SelectInput id={id + '-to'} label={t('setup.links.to')} value={draft.toSiteId} disabled={!editable} onChange={(e) => { update('toSiteId', e.target.value); }}>
              {state.sites.map((site) => (
                <option key={site.id} value={site.id}>{site.code + ' · ' + site.name}</option>
              ))}
            </SelectInput>
            <SelectInput id={id + '-kind'} label={t('setup.links.kind')} value={draft.kind} disabled={!editable} onChange={(e) => { update('kind', e.target.value as LinkKind); }}>
              {LINK_KINDS.map((kind) => (
                <option key={kind} value={kind}>{kindLabel(kind)}</option>
              ))}
            </SelectInput>
            <TextInput id={id + '-provider'} label={t('setup.links.provider')} value={draft.provider} disabled={!editable} onChange={(e) => { update('provider', e.target.value); }} />
            <TextInput id={id + '-circuit'} label={t('setup.links.circuit')} value={draft.circuitId} disabled={!editable} onChange={(e) => { update('circuitId', e.target.value); }} />
            <TextInput id={id + '-bandwidth'} label={t('setup.links.bandwidth')} inputMode="numeric" value={draft.bandwidthMbps} required disabled={!editable} onChange={(e) => { update('bandwidthMbps', e.target.value); }} />
            <TextInput id={id + '-paths'} label={t('setup.links.paths')} inputMode="numeric" value={draft.diversePaths} disabled={!editable} onChange={(e) => { update('diversePaths', e.target.value); }} />
            <SelectInput id={id + '-role'} label={t('setup.links.role')} value={draft.role} disabled={!editable} onChange={(e) => { update('role', e.target.value as LinkRole); }}>
              {ROLES_OF_LINK.map((role) => (
                <option key={role} value={role}>{roleLabel(role)}</option>
              ))}
            </SelectInput>
            <TextInput id={id + '-latency'} label={t('setup.links.latency')} inputMode="decimal" value={draft.latencyMs} disabled={!editable} onChange={(e) => { update('latencyMs', e.target.value); }} />
            <TextInput id={id + '-probe'} label={t('setup.links.probeTarget')} value={draft.probeTarget} disabled={!editable} onChange={(e) => { update('probeTarget', e.target.value); }} />
            <label htmlFor={id + '-replication'} className="flex items-center gap-om-6 text-om-xs text-om-secondary">
              <input id={id + '-replication'} type="checkbox" checked={draft.replication} disabled={!editable} onChange={(e) => { update('replication', e.target.checked); }} />
              {t('setup.links.replication')}
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-om-12">
            <button type="submit" className={PRIMARY_BUTTON} disabled={!editable || !valid || save.isPending}>
              {t('setup.links.save')}
            </button>
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { setOpen(false); }}>
              {t('action.cancel')}
            </button>
            <MutationError error={save.error} />
          </div>
        </form>
      ) : (
        <div>
          <button type="button" className={SECONDARY_BUTTON} disabled={!editable || !canLink} onClick={() => { setOpen(true); }}>
            {t('setup.links.add')}
          </button>
        </div>
      )}
    </StepCard>
  );
}
