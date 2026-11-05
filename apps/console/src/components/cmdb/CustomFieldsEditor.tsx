'use client';
// REQ-CMDB-015 — the CI detail's custom fields: the tenant's fields that apply to the CI's type, each shown with its
// label in the console's locale and its value; operators edit them in one form (a typed control per field: text,
// number, date, yes/no, or a select of the field's options), read with the contract's validator before sending, and
// clear a value by emptying it. A CI type with no fields says where they are defined.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLES } from '@openmap/constants';
import { readCustomFieldValue, type CiType } from '@openmap/contracts';
import { Card, SectionTitle } from '@openmap/ui';
import Link from 'next/link';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Button, Field, Select, TextInput } from '@/components/common/controls';
import { useCan } from '@/lib/auth';
import { customFieldDefinitionsQuery, customFieldsQueryKey, setCiCustomFields, type CustomFieldDefinitionView } from '@/lib/custom-field-queries';
import { localizedHref } from '@/lib/locale-path';
import { useFormatters, useLocale, useT } from '@/providers';

type Values = Record<string, string | number | boolean>;

export interface CustomFieldsEditorProps {
  ci: { id: string; type: string; customFields: Values };
}

/** The form's text for a stored value, and the change the form's texts make against the stored values. */
export function changeOf(defs: readonly CustomFieldDefinitionView[], stored: Values, texts: Readonly<Record<string, string>>): { change: Record<string, string | number | boolean | null>; errors: string[] } {
  const change: Record<string, string | number | boolean | null> = {};
  const errors: string[] = [];
  for (const def of defs) {
    const text = texts[def.key] ?? '';
    const before = stored[def.key];
    if (text.trim() === '') {
      if (before !== undefined) change[def.key] = null;
      if (def.required) errors.push(def.key);
      continue;
    }
    const read = readCustomFieldValue(def, def.type === 'boolean' ? text === 'true' : text);
    if ('error' in read) errors.push(def.key);
    else if (read.value !== before) change[def.key] = read.value;
  }
  return { change, errors };
}

function textOf(value: string | number | boolean | undefined): string {
  return value === undefined ? '' : String(value);
}

export function CustomFieldsEditor({ ci }: CustomFieldsEditorProps): ReactNode {
  const t = useT();
  const locale = useLocale();
  const format = useFormatters();
  const can = useCan();
  const formId = useId();
  const queryClient = useQueryClient();
  const defs = useQuery(customFieldDefinitionsQuery(ci.type as CiType));
  const [texts, setTexts] = useState<Record<string, string> | null>(null);
  const save = useMutation({
    mutationFn: (change: Record<string, string | number | boolean | null>) => setCiCustomFields(ci.id, change),
    onSuccess: async () => {
      setTexts(null);
      await queryClient.invalidateQueries({ queryKey: ['ci', ci.id] });
      await queryClient.invalidateQueries({ queryKey: customFieldsQueryKey });
    },
  });
  const list = defs.data ?? [];
  const label = (def: CustomFieldDefinitionView): string => (locale === 'ar' ? def.labelAr : def.labelEn);
  const shown = (def: CustomFieldDefinitionView): string => {
    const v = ci.customFields[def.key];
    if (v === undefined) return t('customFields.empty');
    if (def.type === 'boolean') return t(v === true ? 'customFields.yes' : 'customFields.no');
    if (def.type === 'number' && typeof v === 'number') return format.number(v);
    if (def.type === 'date' && typeof v === 'string') return format.date(v);
    return String(v);
  };
  const editing = texts !== null;
  const pending = editing ? changeOf(list, ci.customFields, texts) : null;
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (pending === null || pending.errors.length > 0 || Object.keys(pending.change).length === 0) return;
    save.mutate(pending.change);
  };

  return (
    <Card as="section" className="flex flex-col gap-om-12">
      <SectionTitle
        as="h2"
        size="sm"
        action={
          can(ROLES.operator) && list.length > 0 && !editing ? (
            <Button
              tone="quiet"
              onClick={() => {
                save.reset();
                setTexts(Object.fromEntries(list.map((d) => [d.key, textOf(ci.customFields[d.key])])));
              }}
            >
              {t('customFields.editValues')}
            </Button>
          ) : null
        }
      >
        {t('customFields.title')}
      </SectionTitle>
      {list.length === 0 ? (
        <p className="text-om-sm text-om-secondary">
          {t('customFields.noneForType')}{' '}
          <Link href={localizedHref(locale, '/settings')} className="text-om-cyan hover:underline">
            {t('nav.settings')}
          </Link>
        </p>
      ) : !editing ? (
        <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-om-12 gap-y-om-6 text-om-sm" data-testid="custom-field-values">
          {list.map((def) => (
            <div key={def.key} className="contents">
              <dt className="text-om-secondary">{label(def)}</dt>
              <dd className="text-om-primary">{shown(def)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <form onSubmit={onSubmit} aria-label={t('customFields.valuesForm')} className="flex flex-col gap-om-10">
          {list.map((def) => {
            const id = formId + '-' + def.key;
            const value = texts[def.key] ?? '';
            const set = (next: string): void => {
              setTexts({ ...texts, [def.key]: next });
            };
            const invalid = pending?.errors.includes(def.key) === true;
            return (
              <Field key={def.key} id={id} label={label(def) + (def.required ? ' *' : '')} hint={invalid ? t('customFields.valueInvalid') : def.description === '' ? undefined : def.description}>
                {def.type === 'select' || def.type === 'boolean' ? (
                  <Select
                    id={id}
                    value={value}
                    onChange={(e) => {
                      set(e.target.value);
                    }}
                  >
                    <option value="">{t('customFields.empty')}</option>
                    {(def.type === 'boolean' ? ['true', 'false'] : def.options).map((o) => (
                      <option key={o} value={o}>
                        {def.type === 'boolean' ? t(o === 'true' ? 'customFields.yes' : 'customFields.no') : o}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <TextInput
                    id={id}
                    type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'}
                    value={value}
                    onChange={(e) => {
                      set(e.target.value);
                    }}
                  />
                )}
              </Field>
            );
          })}
          <div className="flex flex-wrap items-center gap-om-8">
            <Button type="submit" disabled={pending === null || pending.errors.length > 0 || Object.keys(pending.change).length === 0 || save.isPending}>
              {t('customFields.save')}
            </Button>
            <Button
              tone="quiet"
              onClick={() => {
                setTexts(null);
              }}
            >
              {t('customFields.cancel')}
            </Button>
            {save.isError ? (
              <span role="alert" className="text-om-2xs text-om-rose">
                {save.error instanceof Error ? save.error.message : t('cmdb.detail.saveFailed')}
              </span>
            ) : null}
          </div>
        </form>
      )}
    </Card>
  );
}
