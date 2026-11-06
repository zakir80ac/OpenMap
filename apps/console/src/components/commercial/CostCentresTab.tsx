'use client';
// REQ-CMDB-028 (ADR-035) — customers, departments and cost centres: each cost_centre CI with its kind, code, owner,
// budget, the contracts billed to it and their annual cost, and the assets and plans it owns. Operators add and edit.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { COST_CENTRE_KINDS, type CostCentreKind } from '@openmap/contracts';
import type { MessageKey } from '@openmap/i18n';
import { Card, SectionTitle, Tag } from '@openmap/ui';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import {
  Button,
  Field,
  Select,
  TextInput,
  rowClass,
  tableClass,
  tdClass,
  thClass,
  theadClass,
} from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { costCentresQuery, upsertCostCentre, type CostCentre, type CostCentreInput } from '@/lib/commercial-queries';
import { useFormatters, useT } from '@/providers';
import { fieldText, moneyText, numberOrNull, textOrNull } from './format';

export function centreKindKey(kind: CostCentreKind): MessageKey {
  return ('commercial.costCentre.kind.' + kind) as MessageKey;
}

function CostCentreForm({ centre, onDone }: { centre: CostCentre | null; onDone: () => void }): ReactNode {
  const t = useT();
  const id = useId();
  const queryClient = useQueryClient();
  const [code, setCode] = useState(centre?.code ?? '');
  const [name, setName] = useState(centre?.ci.displayName ?? '');
  const [kind, setKind] = useState<CostCentreKind>(centre?.kind ?? 'cost_centre');
  const [owner, setOwner] = useState(centre?.owner ?? '');
  const [budget, setBudget] = useState(fieldText(centre?.annualBudget?.amount));
  const [currency, setCurrency] = useState(centre?.annualBudget?.currency ?? '');
  const annualBudget = numberOrNull(budget);
  const currencyCode = textOrNull(currency)?.toUpperCase() ?? null;
  const valid = code.trim() !== '' && name.trim() !== '' && (annualBudget === null || currencyCode !== null);
  const mutation = useMutation({
    mutationFn: (input: CostCentreInput) => upsertCostCentre(centre?.ci.id ?? null, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['costCentres'] });
      onDone();
    },
  });
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!valid) return;
    mutation.mutate({
      code: code.trim(),
      name: name.trim(),
      kind,
      owner: textOrNull(owner),
      annualBudget,
      currency: annualBudget === null ? null : currencyCode,
    });
  };
  const title = centre === null ? t('commercial.costCentre.new') : t('commercial.costCentre.edit', { code: centre.code });
  const input = (key: string, label: MessageKey, value: string, onChange: (v: string) => void, extra: { type?: string; disabled?: boolean } = {}): ReactNode => (
    <Field id={id + '-' + key} label={t(label)}>
      <TextInput
        id={id + '-' + key}
        type={extra.type ?? 'text'}
        value={value}
        disabled={extra.disabled === true}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </Field>
  );
  return (
    <form onSubmit={onSubmit} aria-label={title} className="flex flex-col gap-om-12 rounded-om-panel border border-dashed border-om-border-strong p-om-16">
      <h3 className="font-om-display text-om-sm font-semibold text-om-primary">{title}</h3>
      <div className="grid grid-cols-1 gap-om-12 md:grid-cols-3">
        {input('code', 'commercial.costCentre.code', code, setCode, { disabled: centre !== null })}
        {input('name', 'commercial.costCentre.name', name, setName)}
        <Field id={id + '-kind'} label={t('commercial.costCentre.kindLabel')}>
          <Select
            id={id + '-kind'}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as CostCentreKind);
            }}
          >
            {COST_CENTRE_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(centreKindKey(k))}
              </option>
            ))}
          </Select>
        </Field>
        {input('owner', 'commercial.costCentre.owner', owner, setOwner)}
        {input('budget', 'commercial.costCentre.budget', budget, setBudget, { type: 'number' })}
        {input('currency', 'commercial.contract.currency', currency, setCurrency)}
      </div>
      <div className="flex flex-wrap items-center gap-om-10">
        <Button type="submit" disabled={!valid || mutation.isPending}>
          {t('common.save')}
        </Button>
        <Button tone="quiet" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        {mutation.isError ? (
          <span role="alert" className="text-om-xs text-om-state-down">
            {mutation.error instanceof Error ? mutation.error.message : t('commercial.saveError')}
          </span>
        ) : null}
      </div>
    </form>
  );
}

export function CostCentresTab({ canOperate }: { canOperate: boolean }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const [editing, setEditing] = useState<CostCentre | 'new' | null>(null);
  const centres = useQuery(costCentresQuery());
  const list = centres.data ?? [];
  return (
    <Card padding="24" className="flex flex-col gap-om-16" as="section">
      <SectionTitle
        as="h2"
        size="sm"
        description={t('commercial.costCentres.subtitle')}
        action={
          canOperate && editing === null ? (
            <Button
              onClick={() => {
                setEditing('new');
              }}
            >
              {t('commercial.costCentre.new')}
            </Button>
          ) : null
        }
      >
        {t('commercial.costCentres.title')}
      </SectionTitle>
      {editing !== null ? (
        <CostCentreForm
          key={editing === 'new' ? 'new' : editing.ci.id}
          centre={editing === 'new' ? null : editing}
          onDone={() => {
            setEditing(null);
          }}
        />
      ) : null}
      {centres.isPending ? (
        <QueryState status="pending" />
      ) : centres.isError ? (
        <QueryState
          status="error"
          onRetry={() => {
            void centres.refetch();
          }}
        />
      ) : list.length === 0 ? (
        <p className="text-om-sm text-om-secondary">{t('commercial.costCentres.empty')}</p>
      ) : (
        <div className="overflow-x-auto" data-testid="cost-centre-register">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th scope="col" className={thClass}>
                  {t('commercial.costCentre.name')}
                </th>
                <th scope="col" className={thClass}>
                  {t('commercial.costCentre.owner')}
                </th>
                <th scope="col" className={thClass}>
                  {t('commercial.costCentre.budget')}
                </th>
                <th scope="col" className={thClass}>
                  {t('commercial.costCentre.contractCost')}
                </th>
                <th scope="col" className={thClass}>
                  {t('commercial.costCentre.assets')}
                </th>
                <th scope="col" className={thClass}>
                  {t('commercial.costCentre.plans')}
                </th>
                {canOperate ? (
                  <th scope="col" className={thClass}>
                    <span className="sr-only">{t('commercial.edit')}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.ci.id} className={rowClass} data-cost-centre={c.code}>
                  <td className={tdClass + ' text-om-primary'}>
                    {c.ci.displayName}
                    <span className="mt-om-2 flex flex-wrap items-center gap-om-4">
                      <span className="font-om-mono text-om-2xs text-om-muted">{c.code}</span>
                      <Tag>{t(centreKindKey(c.kind))}</Tag>
                    </span>
                  </td>
                  <td className={tdClass + ' text-om-secondary'}>{c.owner ?? t('common.none')}</td>
                  <td className={tdClass + ' font-om-mono text-om-secondary'}>{moneyText(format, c.annualBudget) || t('common.none')}</td>
                  <td className={tdClass + ' font-om-mono text-om-secondary'}>
                    {moneyText(format, c.annualContractCost) || t('common.none')}
                    <span className="block text-om-2xs text-om-muted">{t('commercial.costCentre.contractsN', { count: format.integer(c.contracts) })}</span>
                  </td>
                  <td className={tdClass + ' font-om-mono text-om-secondary'}>{format.integer(c.assets)}</td>
                  <td className={tdClass + ' font-om-mono text-om-secondary'}>{format.integer(c.plans)}</td>
                  {canOperate ? (
                    <td className={tdClass + ' text-end'}>
                      <Button
                        tone="quiet"
                        aria-label={t('commercial.costCentre.edit', { code: c.code })}
                        onClick={() => {
                          setEditing(c);
                        }}
                      >
                        {t('commercial.edit')}
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
