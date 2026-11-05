'use client';
// REQ-CMDB-015 — Settings: the tenant's custom fields. Everyone reads the list (key, labels, type, the CI types each
// applies to, how many CIs carry a value); administrators add a field, edit its labels, options, types and required
// flag (the key is fixed once created), and remove one, which clears its values from every CI after a confirmation.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CUSTOM_FIELDS, ROLES } from '@openmap/constants';
import { CI_TYPES, CUSTOM_FIELD_TYPES, customFieldDefinitionInputSchema, type CustomFieldType } from '@openmap/contracts';
import { Card, SectionTitle, Tag } from '@openmap/ui';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Button, Field, Select, TextInput, rowClass, tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { useCan } from '@/lib/auth';
import {
  customFieldDefinitionsQuery,
  customFieldsQueryKey,
  deleteCustomFieldDefinition,
  upsertCustomFieldDefinition,
  type CustomFieldDefinitionView,
} from '@/lib/custom-field-queries';
import { useFormatters, useLocale, useT } from '@/providers';

interface Draft {
  id: string | null;
  key: string;
  labelEn: string;
  labelAr: string;
  description: string;
  type: CustomFieldType;
  options: string;
  appliesTo: string[];
  required: boolean;
}

const EMPTY: Draft = { id: null, key: '', labelEn: '', labelAr: '', description: '', type: 'text', options: '', appliesTo: [], required: false };

function draftOf(def: CustomFieldDefinitionView): Draft {
  return { id: def.id, key: def.key, labelEn: def.labelEn, labelAr: def.labelAr, description: def.description, type: def.type, options: def.options.join(', '), appliesTo: def.appliesTo, required: def.required };
}

/** The draft as the contract's input, or the first reason it is not one yet. */
export function inputOf(draft: Draft): { input: ReturnType<typeof customFieldDefinitionInputSchema.parse> } | { error: string } {
  const options = draft.options.split(',').map((o) => o.trim()).filter((o) => o !== '');
  const parsed = customFieldDefinitionInputSchema.safeParse({ key: draft.key.trim(), labelEn: draft.labelEn, labelAr: draft.labelAr, description: draft.description, type: draft.type, options: draft.type === 'select' ? options : [], appliesTo: draft.appliesTo, required: draft.required });
  return parsed.success ? { input: parsed.data } : { error: parsed.error.issues[0]?.path.join('.') ?? 'input' };
}

export function CustomFieldsCard(): ReactNode {
  const t = useT();
  const locale = useLocale();
  const format = useFormatters();
  const can = useCan();
  const admin = can(ROLES.admin);
  const formId = useId();
  const queryClient = useQueryClient();
  const definitions = useQuery(customFieldDefinitionsQuery());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: customFieldsQueryKey });
  const save = useMutation({
    mutationFn: ({ id, input }: { id: string | null; input: ReturnType<typeof customFieldDefinitionInputSchema.parse> }) => upsertCustomFieldDefinition(id, input),
    onSuccess: async () => {
      setDraft(null);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteCustomFieldDefinition(id),
    onSuccess: async () => {
      setConfirming(null);
      await refresh();
    },
  });
  const checked = draft === null ? null : inputOf(draft);
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (draft === null || checked === null || 'error' in checked) return;
    save.mutate({ id: draft.id, input: checked.input });
  };
  const list = definitions.data ?? [];

  return (
    <Card as="section" className="flex flex-col gap-om-12">
      <SectionTitle
        as="h2"
        size="sm"
        description={t('customFields.subtitle')}
        action={
          admin && draft === null ? (
            <Button
              onClick={() => {
                save.reset();
                setDraft(EMPTY);
              }}
            >
              {t('customFields.add')}
            </Button>
          ) : null
        }
      >
        {t('customFields.title')}
      </SectionTitle>

      {list.length === 0 ? (
        <p className="text-om-sm text-om-secondary">{t('customFields.none')}</p>
      ) : (
        <table className={tableClass} aria-label={t('customFields.title')}>
          <thead className={theadClass}>
            <tr>
              <th scope="col" className={thClass}>{t('customFields.column.field')}</th>
              <th scope="col" className={thClass}>{t('customFields.column.type')}</th>
              <th scope="col" className={thClass}>{t('customFields.column.appliesTo')}</th>
              <th scope="col" className={thClass}>{t('customFields.column.usage')}</th>
              {admin ? <th scope="col" className={thClass}><span className="sr-only">{t('customFields.column.actions')}</span></th> : null}
            </tr>
          </thead>
          <tbody>
            {list.map((def) => (
              <tr key={def.id} className={rowClass} data-testid="custom-field-row">
                <td className={tdClass}>
                  <span className="block text-om-sm text-om-primary">{locale === 'ar' ? def.labelAr : def.labelEn}</span>
                  <span className="font-om-mono text-om-2xs text-om-muted">{def.key}</span>
                  {def.required ? <Tag>{t('customFields.required')}</Tag> : null}
                </td>
                <td className={tdClass}>
                  {t(`customFields.type.${def.type}`)}
                  {def.type === 'select' ? <span className="block text-om-2xs text-om-muted">{def.options.join(', ')}</span> : null}
                </td>
                <td className={tdClass + ' text-om-2xs'}>{def.appliesTo.length === 0 ? t('customFields.allTypes') : def.appliesTo.join(', ')}</td>
                <td className={tdClass}>{format.integer(def.usage)}</td>
                {admin ? (
                  <td className={tdClass}>
                    <span className="flex gap-om-6">
                      <Button
                        tone="quiet"
                        aria-label={t('customFields.edit', { key: def.key })}
                        onClick={() => {
                          save.reset();
                          setDraft(draftOf(def));
                        }}
                      >
                        {t('customFields.editShort')}
                      </Button>
                      {confirming === def.id ? (
                        <Button
                          tone="danger"
                          disabled={remove.isPending}
                          onClick={() => {
                            remove.mutate(def.id);
                          }}
                        >
                          {t('customFields.confirmDelete', { count: format.integer(def.usage) })}
                        </Button>
                      ) : (
                        <Button
                          tone="quiet"
                          aria-label={t('customFields.delete', { key: def.key })}
                          onClick={() => {
                            setConfirming(def.id);
                          }}
                        >
                          {t('customFields.deleteShort')}
                        </Button>
                      )}
                    </span>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {admin && draft !== null ? (
        <form onSubmit={onSubmit} aria-label={t('customFields.form')} className="grid gap-om-12 rounded-om-panel border border-om-border-glass p-om-12 md:grid-cols-2">
          <Field id={formId + '-key'} label={t('customFields.field.key')} hint={t('customFields.field.keyHint')}>
            <TextInput
              id={formId + '-key'}
              value={draft.key}
              disabled={draft.id !== null}
              maxLength={CUSTOM_FIELDS.maxLabelLength}
              onChange={(e) => {
                setDraft({ ...draft, key: e.target.value });
              }}
            />
          </Field>
          <Field id={formId + '-type'} label={t('customFields.field.type')}>
            <Select
              id={formId + '-type'}
              value={draft.type}
              onChange={(e) => {
                setDraft({ ...draft, type: e.target.value as CustomFieldType });
              }}
            >
              {CUSTOM_FIELD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`customFields.type.${type}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={formId + '-en'} label={t('customFields.field.labelEn')}>
            <TextInput
              id={formId + '-en'}
              value={draft.labelEn}
              maxLength={CUSTOM_FIELDS.maxLabelLength}
              onChange={(e) => {
                setDraft({ ...draft, labelEn: e.target.value });
              }}
            />
          </Field>
          <Field id={formId + '-ar'} label={t('customFields.field.labelAr')}>
            <TextInput
              id={formId + '-ar'}
              dir="rtl"
              value={draft.labelAr}
              maxLength={CUSTOM_FIELDS.maxLabelLength}
              onChange={(e) => {
                setDraft({ ...draft, labelAr: e.target.value });
              }}
            />
          </Field>
          {draft.type === 'select' ? (
            <Field id={formId + '-options'} label={t('customFields.field.options')} hint={t('customFields.field.optionsHint')}>
              <TextInput
                id={formId + '-options'}
                value={draft.options}
                onChange={(e) => {
                  setDraft({ ...draft, options: e.target.value });
                }}
              />
            </Field>
          ) : null}
          <Field id={formId + '-applies'} label={t('customFields.field.appliesTo')} hint={t('customFields.field.appliesToHint')}>
            <Select
              id={formId + '-applies'}
              multiple
              value={draft.appliesTo}
              className="h-28"
              onChange={(e) => {
                setDraft({ ...draft, appliesTo: [...e.target.selectedOptions].map((o) => o.value) });
              }}
            >
              {CI_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex items-center gap-om-8 text-om-sm text-om-secondary">
            <input
              type="checkbox"
              checked={draft.required}
              onChange={(e) => {
                setDraft({ ...draft, required: e.target.checked });
              }}
            />
            {t('customFields.field.required')}
          </label>
          <div className="flex flex-wrap items-center gap-om-8 md:col-span-2">
            <Button type="submit" disabled={checked === null || 'error' in checked || save.isPending}>
              {t('customFields.save')}
            </Button>
            <Button
              tone="quiet"
              onClick={() => {
                setDraft(null);
              }}
            >
              {t('customFields.cancel')}
            </Button>
            {checked !== null && 'error' in checked ? <span className="text-om-2xs text-om-amber">{t('customFields.invalid', { field: checked.error })}</span> : null}
            {save.isError ? (
              <span role="alert" className="text-om-2xs text-om-rose">
                {save.error instanceof Error ? save.error.message : t('cmdb.detail.saveFailed')}
              </span>
            ) : null}
          </div>
        </form>
      ) : null}
    </Card>
  );
}
