'use client';
// REQ-CMDB-026 REQ-CMDB-029 (ADR-035) — the contract register: every contract CI with its kind, vendor, cost centre,
// end date and days left, notice date, annual cost, covered assets and documents; filters by kind, horizon, expiry and
// text; operators add and edit contracts (documents by reference: title and location).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { COMMERCIAL } from '@openmap/constants';
import { CONTRACT_KINDS, SUPPORT_LEVELS, type ContractKind } from '@openmap/contracts';
import type { Locale, MessageKey } from '@openmap/i18n';
import { Card, SectionTitle, StateBadge, Tag } from '@openmap/ui';
import Link from 'next/link';
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
import {
  contractsQuery,
  costCentresQuery,
  upsertContract,
  vendorsQuery,
  type Contract,
  type ContractDocument,
  type ContractFilter,
  type ContractInput,
} from '@/lib/commercial-queries';
import { localizedHref } from '@/lib/locale-path';
import { useFormatters, useT } from '@/providers';
import { fieldText, moneyText, numberOrNull, textOrNull } from './format';

const DAY_LENGTH = 'YYYY-MM-DD'.length;

export function kindKey(kind: ContractKind): MessageKey {
  return ('commercial.contract.kind.' + kind) as MessageKey;
}

/** A document location opens as a link only when it is a web address; a file-share path stays text. */
export function isLink(location: string): boolean {
  try {
    return (COMMERCIAL.linkProtocols as readonly string[]).includes(new URL(location).protocol);
  } catch {
    return false;
  }
}

/** The state an end date is shown in: ended, ending inside the at-risk window, or fine. */
export function endState(contract: Pick<Contract, 'expired' | 'daysToEnd'>): 'down' | 'at_risk' | 'healthy' | 'unknown' {
  if (contract.daysToEnd === null) return 'unknown';
  if (contract.expired) return 'down';
  return contract.daysToEnd <= COMMERCIAL.atRiskDays ? 'at_risk' : 'healthy';
}

/** Draft fields typed into a text box. */
type TextKey = 'contractNumber' | 'title' | 'responseMinutes' | 'startsAt' | 'endsAt' | 'noticeDays' | 'annualCost' | 'currency';

interface ContractDraft {
  vendorId: string;
  costCentreId: string;
  contractNumber: string;
  kind: ContractKind;
  title: string;
  level: string;
  responseMinutes: string;
  startsAt: string;
  endsAt: string;
  autoRenews: boolean;
  noticeDays: string;
  annualCost: string;
  currency: string;
  documents: ContractDocument[];
}

function draftOf(contract: Contract | null): ContractDraft {
  return {
    vendorId: contract?.vendor?.id ?? '',
    costCentreId: contract?.costCentre?.id ?? '',
    contractNumber: contract?.contractNumber ?? '',
    kind: contract?.kind ?? 'support',
    title: contract?.title ?? '',
    level: contract?.level ?? '',
    responseMinutes: fieldText(contract?.responseMinutes),
    startsAt: contract?.startsAt?.slice(0, DAY_LENGTH) ?? '',
    endsAt: contract?.endsAt?.slice(0, DAY_LENGTH) ?? '',
    autoRenews: contract?.autoRenews ?? false,
    noticeDays: fieldText(contract?.noticeDays),
    annualCost: fieldText(contract?.annualCost?.amount),
    currency: contract?.annualCost?.currency ?? '',
    documents: contract?.documents ?? [],
  };
}

/** The draft as the mutation's input, or null while a required field is missing. */
export function toContractInput(d: ContractDraft): ContractInput | null {
  const documents = d.documents.filter((doc) => doc.title.trim() !== '' && doc.location.trim() !== '');
  const annualCost = numberOrNull(d.annualCost);
  const currency = textOrNull(d.currency)?.toUpperCase() ?? null;
  if (d.vendorId === '' || d.contractNumber.trim() === '' || d.title.trim() === '' || d.startsAt === '' || d.endsAt === '') return null;
  if (d.endsAt < d.startsAt || (annualCost !== null && currency === null)) return null;
  return {
    vendorId: d.vendorId,
    costCentreId: d.costCentreId === '' ? null : d.costCentreId,
    contractNumber: d.contractNumber.trim(),
    kind: d.kind,
    title: d.title.trim(),
    level: d.level === '' ? null : d.level,
    responseMinutes: numberOrNull(d.responseMinutes),
    startsAt: d.startsAt,
    endsAt: d.endsAt,
    autoRenews: d.autoRenews,
    noticeDays: numberOrNull(d.noticeDays),
    annualCost,
    currency: annualCost === null ? null : currency,
    documents: documents.map((doc) => ({ title: doc.title.trim(), location: doc.location.trim() })),
  };
}

interface ContractFormProps {
  contract: Contract | null;
  onDone: () => void;
}

function ContractForm({ contract, onDone }: ContractFormProps): ReactNode {
  const t = useT();
  const id = useId();
  const queryClient = useQueryClient();
  const vendors = useQuery(vendorsQuery(null));
  const centres = useQuery(costCentresQuery());
  const [draft, setDraft] = useState<ContractDraft>(() => draftOf(contract));
  const input = toContractInput(draft);
  const mutation = useMutation({
    mutationFn: (value: ContractInput) => upsertContract(contract?.ci.id ?? null, value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['contracts'] });
      await queryClient.invalidateQueries({ queryKey: ['vendors'] });
      await queryClient.invalidateQueries({ queryKey: ['vendor'] });
      await queryClient.invalidateQueries({ queryKey: ['costCentres'] });
      onDone();
    },
  });
  const set = (patch: Partial<ContractDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };
  const setDocument = (index: number, patch: Partial<ContractDocument>): void => {
    set({ documents: draft.documents.map((doc, i) => (i === index ? { ...doc, ...patch } : doc)) });
  };
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (input !== null) mutation.mutate(input);
  };
  const text = (key: TextKey, label: MessageKey, type = 'text'): ReactNode => (
    <Field id={id + '-' + key} label={t(label)}>
      <TextInput
        id={id + '-' + key}
        type={type}
        value={draft[key]}
        disabled={contract !== null && key === 'contractNumber'}
        onChange={(event) => {
          set({ [key]: event.target.value });
        }}
      />
    </Field>
  );

  return (
    <form
      onSubmit={onSubmit}
      aria-label={contract === null ? t('commercial.contract.new') : t('commercial.contract.edit', { number: contract.contractNumber })}
      className="flex flex-col gap-om-12 rounded-om-panel border border-dashed border-om-border-strong p-om-16"
    >
      <h3 className="font-om-display text-om-sm font-semibold text-om-primary">
        {contract === null ? t('commercial.contract.new') : t('commercial.contract.edit', { number: contract.contractNumber })}
      </h3>
      <div className="grid grid-cols-1 gap-om-12 md:grid-cols-3">
        <Field id={id + '-vendor'} label={t('commercial.contract.vendor')}>
          <Select
            id={id + '-vendor'}
            value={draft.vendorId}
            disabled={contract !== null}
            onChange={(event) => {
              set({ vendorId: event.target.value });
            }}
          >
            <option value="">{t('common.none')}</option>
            {(vendors.data ?? []).map((v) => (
              <option key={v.ci.id} value={v.ci.id}>
                {v.ci.displayName}
              </option>
            ))}
          </Select>
        </Field>
        {text('contractNumber', 'commercial.contract.number')}
        {text('title', 'commercial.contract.title')}
        <Field id={id + '-kind'} label={t('commercial.contract.kindLabel')}>
          <Select
            id={id + '-kind'}
            value={draft.kind}
            onChange={(event) => {
              set({ kind: event.target.value as ContractKind });
            }}
          >
            {CONTRACT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(kindKey(kind))}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={id + '-level'} label={t('commercial.contract.level')}>
          <Select
            id={id + '-level'}
            value={draft.level}
            onChange={(event) => {
              set({ level: event.target.value });
            }}
          >
            <option value="">{t('common.none')}</option>
            {SUPPORT_LEVELS.map((level) => (
              <option key={level} value={level}>
                {t(('commercial.contract.levels.' + level) as MessageKey)}
              </option>
            ))}
          </Select>
        </Field>
        {text('responseMinutes', 'commercial.contract.responseMinutes', 'number')}
        {text('startsAt', 'commercial.contract.startsAt', 'date')}
        {text('endsAt', 'commercial.contract.endsAt', 'date')}
        {text('noticeDays', 'commercial.contract.noticeDays', 'number')}
        {text('annualCost', 'commercial.contract.annualCost', 'number')}
        {text('currency', 'commercial.contract.currency')}
        <Field id={id + '-centre'} label={t('commercial.contract.costCentre')}>
          <Select
            id={id + '-centre'}
            value={draft.costCentreId}
            onChange={(event) => {
              set({ costCentreId: event.target.value });
            }}
          >
            <option value="">{t('common.none')}</option>
            {(centres.data ?? []).map((c) => (
              <option key={c.ci.id} value={c.ci.id}>
                {c.code + ' · ' + c.ci.displayName}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <label className="flex items-center gap-om-6 text-om-xs text-om-secondary">
        <input
          type="checkbox"
          checked={draft.autoRenews}
          onChange={(event) => {
            set({ autoRenews: event.target.checked });
          }}
        />
        <span>{t('commercial.contract.autoRenews')}</span>
      </label>
      <fieldset className="flex flex-col gap-om-8">
        <legend className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('commercial.contract.documents')}</legend>
        {draft.documents.map((doc, index) => (
          <div key={index} className="grid grid-cols-1 gap-om-8 md:grid-cols-[1fr_2fr_auto]">
            <TextInput
              aria-label={t('commercial.contract.documentTitle', { n: String(index + 1) })}
              value={doc.title}
              onChange={(event) => {
                setDocument(index, { title: event.target.value });
              }}
            />
            <TextInput
              aria-label={t('commercial.contract.documentLocation', { n: String(index + 1) })}
              value={doc.location}
              onChange={(event) => {
                setDocument(index, { location: event.target.value });
              }}
            />
            <Button
              tone="quiet"
              onClick={() => {
                set({ documents: draft.documents.filter((_, i) => i !== index) });
              }}
            >
              {t('commercial.contract.removeDocument')}
            </Button>
          </div>
        ))}
        <span>
          <Button
            tone="quiet"
            onClick={() => {
              set({ documents: [...draft.documents, { title: '', location: '' }] });
            }}
          >
            {t('commercial.contract.addDocument')}
          </Button>
        </span>
      </fieldset>
      <div className="flex flex-wrap items-center gap-om-10">
        <Button type="submit" disabled={input === null || mutation.isPending}>
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

export interface ContractsTabProps {
  locale: Locale;
  canOperate: boolean;
}

export function ContractsTab({ locale, canOperate }: ContractsTabProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const [text, setText] = useState('');
  const [kind, setKind] = useState<ContractKind | ''>('');
  const [horizon, setHorizon] = useState('');
  const [expiredOnly, setExpiredOnly] = useState(false);
  const [editing, setEditing] = useState<Contract | 'new' | null>(null);
  const filter: ContractFilter = {};
  if (text.trim() !== '') filter.text = text.trim();
  if (kind !== '') filter.kinds = [kind];
  if (horizon !== '') filter.expiringWithinDays = Number(horizon);
  if (expiredOnly) filter.expired = true;
  const contracts = useQuery(contractsQuery(filter));
  const list = contracts.data ?? [];
  const ciHref = (ciId: string): string => localizedHref(locale, '/cmdb/' + encodeURIComponent(ciId));

  return (
    <Card padding="24" className="flex flex-col gap-om-16" as="section">
      <SectionTitle
        as="h2"
        size="sm"
        description={t('commercial.contracts.subtitle')}
        action={
          canOperate && editing === null ? (
            <Button
              onClick={() => {
                setEditing('new');
              }}
            >
              {t('commercial.contract.new')}
            </Button>
          ) : null
        }
      >
        {t('commercial.contracts.title')}
      </SectionTitle>
      {editing !== null ? (
        <ContractForm
          key={editing === 'new' ? 'new' : editing.ci.id}
          contract={editing === 'new' ? null : editing}
          onDone={() => {
            setEditing(null);
          }}
        />
      ) : null}
      <div className="flex flex-wrap items-end gap-om-10">
        <Field id={id + '-text'} label={t('commercial.filter.contracts')}>
          <TextInput
            id={id + '-text'}
            type="search"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
        </Field>
        <Field id={id + '-kind'} label={t('commercial.contract.kindLabel')}>
          <Select
            id={id + '-kind'}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as ContractKind | '');
            }}
          >
            <option value="">{t('commercial.filter.allKinds')}</option>
            {CONTRACT_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(kindKey(k))}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={id + '-horizon'} label={t('commercial.filter.endingWithin')}>
          <Select
            id={id + '-horizon'}
            value={horizon}
            onChange={(event) => {
              setHorizon(event.target.value);
            }}
          >
            <option value="">{t('commercial.filter.anyEnd')}</option>
            {COMMERCIAL.expiryHorizonsDays.map((days) => (
              <option key={days} value={String(days)}>
                {t('commercial.filter.days', { days: format.integer(days) })}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex items-center gap-om-6 pb-om-6 text-om-xs text-om-secondary">
          <input
            type="checkbox"
            checked={expiredOnly}
            onChange={(event) => {
              setExpiredOnly(event.target.checked);
            }}
          />
          <span>{t('commercial.filter.expiredOnly')}</span>
        </label>
      </div>
      {contracts.isPending ? (
        <QueryState status="pending" />
      ) : contracts.isError ? (
        <QueryState
          status="error"
          onRetry={() => {
            void contracts.refetch();
          }}
        />
      ) : list.length === 0 ? (
        <p className="text-om-sm text-om-secondary">{t('commercial.contracts.empty')}</p>
      ) : (
        <div className="overflow-x-auto" data-testid="contract-register">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th scope="col" className={thClass}>
                  {t('commercial.contract.title')}
                </th>
                <th scope="col" className={thClass}>
                  {t('commercial.contract.vendor')}
                </th>
                <th scope="col" className={thClass}>
                  {t('commercial.contract.endsAt')}
                </th>
                <th scope="col" className={thClass}>
                  {t('commercial.contract.noticeBy')}
                </th>
                <th scope="col" className={thClass}>
                  {t('commercial.contract.annualCost')}
                </th>
                <th scope="col" className={thClass}>
                  {t('commercial.contract.covered')}
                </th>
                <th scope="col" className={thClass}>
                  {t('commercial.contract.documents')}
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
                <tr key={c.ci.id} className={rowClass} data-contract-number={c.contractNumber}>
                  <td className={tdClass}>
                    <Link href={ciHref(c.ci.id)} className="text-om-primary hover:text-om-cyan">
                      {c.title}
                    </Link>
                    <span className="block font-om-mono text-om-2xs text-om-muted">{c.contractNumber}</span>
                    <span className="mt-om-2 flex flex-wrap gap-om-4">
                      <Tag>{t(kindKey(c.kind))}</Tag>
                      {c.costCentre !== null ? <Tag>{c.costCentre.displayName}</Tag> : null}
                      {c.autoRenews ? <Tag>{t('commercial.contract.autoRenews')}</Tag> : null}
                    </span>
                  </td>
                  <td className={tdClass + ' text-om-secondary'}>{c.vendor?.displayName ?? t('common.none')}</td>
                  <td className={tdClass}>
                    {c.endsAt === null ? (
                      t('common.none')
                    ) : (
                      <span className="flex flex-col gap-om-2">
                        <span className="text-om-secondary">{format.date(c.endsAt)}</span>
                        <StateBadge
                          state={endState(c)}
                          label={
                            c.expired
                              ? t('commercial.contract.endedAgo', { days: format.integer(-(c.daysToEnd ?? 0)) })
                              : t('commercial.contract.daysLeft', { days: format.integer(c.daysToEnd ?? 0) })
                          }
                        />
                      </span>
                    )}
                  </td>
                  <td className={tdClass + ' text-om-secondary'}>{c.noticeBy === null ? t('common.none') : format.date(c.noticeBy)}</td>
                  <td className={tdClass + ' font-om-mono text-om-secondary'}>{moneyText(format, c.annualCost) || t('common.none')}</td>
                  <td className={tdClass + ' font-om-mono text-om-secondary'}>{format.integer(c.coveredAssets)}</td>
                  <td className={tdClass}>
                    {c.documents.length === 0
                      ? t('common.none')
                      : c.documents.map((doc) =>
                          isLink(doc.location) ? (
                            <a key={doc.location} href={doc.location} target="_blank" rel="noreferrer" className="block text-om-cyan hover:underline">
                              {doc.title}
                            </a>
                          ) : (
                            <span key={doc.location} className="block text-om-secondary" title={doc.location}>
                              {doc.title}
                            </span>
                          ),
                        )}
                  </td>
                  {canOperate ? (
                    <td className={tdClass + ' text-end'}>
                      <Button
                        tone="quiet"
                        aria-label={t('commercial.contract.edit', { number: c.contractNumber })}
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
