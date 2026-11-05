'use client';
// REQ-CMDB-040 — manual entry for equipment discovery cannot see (ADR-023): layer, type, name and tag, then the same
// details every register row carries; createAsset makes the CI and the asset together.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CI_LAYERS, CI_TYPES, CI_TYPE_LAYER, OWNED_CI_TYPES, type CiLayer } from '@openmap/contracts';
import { Card, SectionTitle } from '@openmap/ui';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { Field, Select, TextInput } from '@/components/common/controls';
import { Icon } from '@/components/icons';
import { labelableLayers } from '@/lib/attributes';
import { createAsset, type AssetDetailsInput, type AssetRecord } from '@/lib/estate-queries';
import { layerKey } from '@/lib/keys';
import { useT } from '@/providers';
import { AssetDetailsForm } from './AssetDetailsForm';

export interface ManualAssetFormProps {
  onCreated: (asset: AssetRecord) => void;
}

const OWNED: ReadonlySet<string> = new Set(OWNED_CI_TYPES);

export function ManualAssetForm({ onCreated }: ManualAssetFormProps): ReactNode {
  const t = useT();
  const id = useId();
  const queryClient = useQueryClient();
  const layers = useMemo(() => labelableLayers(CI_LAYERS), []);
  const [layer, setLayer] = useState<CiLayer>('dc');
  const types = useMemo(
    () => CI_TYPES.filter((type) => CI_TYPE_LAYER[type] === layer && OWNED.has(type)),
    [layer],
  );
  const [type, setType] = useState<string>('pdu');
  const [name, setName] = useState('');
  const [assetTag, setAssetTag] = useState('');
  const mutation = useMutation({
    mutationFn: (details: AssetDetailsInput) =>
      createAsset({
        layer,
        type,
        name: name.trim(),
        assetTag: assetTag.trim() === '' ? null : assetTag.trim(),
        details,
      }),
    onSuccess: async (asset) => {
      await queryClient.invalidateQueries({ queryKey: ['assets'] });
      await queryClient.invalidateQueries({ queryKey: ['assetSummary'] });
      await queryClient.invalidateQueries({ queryKey: ['layers'] });
      onCreated(asset);
    },
  });
  const typeValid = types.includes(type as (typeof types)[number]);
  return (
    <Card as="section" padding="24" className="flex flex-col gap-om-14">
      <SectionTitle
        as="h2"
        size="sm"
        description={t('assets.manual.hint')}
        action={<Icon name="assets" className="size-5 text-om-violet" />}
      >
        {t('assets.manual.title')}
      </SectionTitle>
      <AssetDetailsForm
        ciType={type}
        initial={null}
        label={t('assets.manual.title')}
        submitLabel={t('assets.manual.create')}
        pending={mutation.isPending}
        head={
          <div className="grid grid-cols-1 gap-om-10 md:grid-cols-2">
            <Field id={id + 'name'} label={t('assets.manual.name')}>
              <TextInput
                id={id + 'name'}
                value={name}
                required
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </Field>
            <Field id={id + 'tag'} label={t('assets.manual.assetTag')} hint={t('assets.manual.assetTagHint')}>
              <TextInput
                id={id + 'tag'}
                value={assetTag}
                onChange={(event) => {
                  setAssetTag(event.target.value);
                }}
              />
            </Field>
            <Field id={id + 'layer'} label={t('assets.manual.layer')}>
              <Select
                id={id + 'layer'}
                value={layer}
                onChange={(event) => {
                  const next = event.target.value;
                  if ((CI_LAYERS as readonly string[]).includes(next)) {
                    setLayer(next as CiLayer);
                    const first = CI_TYPES.find(
                      (candidate) => CI_TYPE_LAYER[candidate] === next && OWNED.has(candidate),
                    );
                    setType(first ?? '');
                  }
                }}
              >
                {layers.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {t(layerKey(candidate))}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id={id + 'type'} label={t('assets.manual.type')}>
              <Select
                id={id + 'type'}
                value={type}
                onChange={(event) => {
                  setType(event.target.value);
                }}
              >
                {types.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {candidate}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        }
        status={
          mutation.isSuccess ? (
            <span role="status" className="text-om-xs text-om-state-healthy">
              {t('assets.manual.created', { tag: mutation.data.assetTag })}
            </span>
          ) : mutation.isError ? (
            <span role="alert" className="text-om-xs text-om-state-down">
              {t('assets.manual.error')}
            </span>
          ) : null
        }
        onSubmit={(details) => {
          if (name.trim() === '' || !typeValid) return;
          mutation.mutate(details);
        }}
      />
    </Card>
  );
}
