'use client';
// REQ-UI-008 REQ-CMDB-012 — "Label this CI": classifies a CI discovered as `unknown` through the labelCi mutation
// (title, description, layer, optional type constrained to the chosen layer). The label outranks every collector.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ROLES } from '@openmap/constants';
import { useCan } from '@/lib/auth';
import { CI_LAYERS, CI_TYPES, CI_TYPE_LAYER, type CiLayer } from '@openmap/contracts';
import { Card, Pill, SectionTitle, Tag, layerColor } from '@openmap/ui';
import { useId, useMemo, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Icon } from '@/components/icons';
import { labelableLayers } from '@/lib/attributes';
import { layerKey } from '@/lib/keys';
import { labelCi, type CiDetail } from '@/lib/queries';
import { useT } from '@/providers';

export interface LabelCiPanelProps {
  ci: CiDetail;
}

const fieldClass =
  'h-10 w-full rounded-om-control-lg border border-om-border-glass bg-om-surface1/80 px-om-10 text-om-sm text-om-primary outline-none transition-[border-color,box-shadow] duration-om-base ease-om-standard focus:border-om-violet/40 focus:shadow-om-glow-bar-violet';

export function LabelCiPanel({ ci }: LabelCiPanelProps): ReactNode {
  const t = useT();
  const ids = { title: useId(), description: useId(), layer: useId(), type: useId() };
  const queryClient = useQueryClient();
  const layers = useMemo(() => labelableLayers(CI_LAYERS), []);
  const [title, setTitle] = useState(ci.userLabel?.title ?? ci.displayName);
  const [description, setDescription] = useState(ci.userLabel?.description ?? '');
  const [layer, setLayer] = useState<CiLayer>(ci.userLabel?.layer ?? layers[0] ?? 'applications');
  const [type, setType] = useState<string>(ci.userLabel?.type ?? '');
  const types = useMemo(() => CI_TYPES.filter((candidate) => CI_TYPE_LAYER[candidate] === layer), [layer]);

  const can = useCan();
  const allowed = can(ROLES.operator);
  const mutation = useMutation({
    mutationFn: labelCi,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ci', ci.id] });
      await queryClient.invalidateQueries({ queryKey: ['layers'] });
    },
  });

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (title.trim() === '') return;
    mutation.mutate({ ciId: ci.id, title: title.trim(), description: description.trim(), layer, ...(type === '' ? {} : { type }) });
  };

  return (
    <Card as="section" className="flex flex-col gap-om-14 border border-om-violet/30 shadow-om-glow-nav-violet">
      <SectionTitle as="h2" size="sm" description={t('cmdb.detail.label.hint')} action={<Icon name="tag" className="size-5 text-om-violet" />}>
        {t('cmdb.detail.label.title')}
      </SectionTitle>
      <form onSubmit={onSubmit} className="grid grid-cols-1 gap-om-12 md:grid-cols-2">
        <label htmlFor={ids.title} className="flex flex-col gap-om-4 md:col-span-2">
          <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('cmdb.detail.label.name')}</span>
          <input
            id={ids.title}
            value={title}
            required
            onChange={(event) => {
              setTitle(event.target.value);
            }}
            className={fieldClass}
          />
        </label>
        <label htmlFor={ids.description} className="flex flex-col gap-om-4 md:col-span-2">
          <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('cmdb.detail.label.description')}</span>
          <textarea
            id={ids.description}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
            className="min-h-20 w-full rounded-om-control-lg border border-om-border-glass bg-om-surface1/80 px-om-10 py-om-8 text-om-sm text-om-primary outline-none focus:border-om-violet/40 focus:shadow-om-glow-bar-violet"
          />
        </label>
        <label htmlFor={ids.layer} className="flex flex-col gap-om-4">
          <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('cmdb.detail.label.layer')}</span>
          <select
            id={ids.layer}
            value={layer}
            onChange={(event) => {
              const next = event.target.value;
              if ((CI_LAYERS as readonly string[]).includes(next)) {
                setLayer(next as CiLayer);
                setType('');
              }
            }}
            className={fieldClass}
            style={{ borderColor: layerColor(layer) }}
          >
            {layers.map((candidate) => (
              <option key={candidate} value={candidate}>
                {t(layerKey(candidate))}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={ids.type} className="flex flex-col gap-om-4">
          <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('cmdb.detail.label.type')}</span>
          <select
            id={ids.type}
            value={type}
            onChange={(event) => {
              setType(event.target.value);
            }}
            className={fieldClass}
          >
            <option value="">{t('cmdb.detail.label.keepType')}</option>
            {types.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-om-10 md:col-span-2">
          <button
            type="submit"
            disabled={mutation.isPending || title.trim() === '' || !allowed}
            title={allowed ? undefined : t('auth.requiresRole', { role: ROLES.operator })}
            className="rounded-om-control-lg bg-om-violet px-om-14 py-om-8 text-om-sm font-semibold text-om-primary shadow-om-glow-button-violet transition-opacity duration-om-base hover:opacity-90 disabled:opacity-60"
          >
            {mutation.isPending ? t('cmdb.detail.label.saving') : t('cmdb.detail.label.submit')}
          </button>
          {allowed ? null : <span className="text-om-xs text-om-muted">{t('auth.requiresRole', { role: ROLES.operator })}</span>}
          {mutation.isSuccess ? (
            <Pill variant="violet" icon={<Icon name="check" className="size-3.5" />}>
              {t('cmdb.detail.label.saved', { layer: t(layerKey(mutation.data.layer)) })}
            </Pill>
          ) : null}
          {mutation.isError ? (
            <span role="alert">
              <Tag variant="state" state="down">
                {t('cmdb.detail.label.error')}
              </Tag>
            </span>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
