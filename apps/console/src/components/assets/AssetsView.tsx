'use client';
// REQ-UI-009 REQ-CMDB-030 — Assets: lifecycle KPIs over the register, the attention table (warranty or vendor support
// ending within the chosen horizon), the asset register with stage changes, and infrastructure plans with their bill
// of materials (ADR-005: plans, not purchase orders). Operators change stages and create plans; everyone else reads.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ASSETS, ROLES, TIME } from '@openmap/constants';
import { CI_LAYERS, PLAN_KINDS, type CiLayer } from '@openmap/contracts';
import type { Locale, MessageKey } from '@openmap/i18n';
import { Card, Kpi, Pill, SectionTitle, StateBadge, Tag, layerColor } from '@openmap/ui';
import Link from 'next/link';
import { useId, useMemo, useState, type ReactNode, type SyntheticEvent } from 'react';
import {
  Button,
  Field,
  Select,
  TextArea,
  TextInput,
  rowClass,
  tableClass,
  tdClass,
  thClass,
  theadClass,
} from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { Icon } from '@/components/icons';
import { useCan } from '@/lib/auth';
import {
  ASSET_STAGES,
  assetsQuery,
  createPlan,
  plansQuery,
  setAssetStage,
  setPlanStatus,
  type AssetRecord,
  type AssetStage,
  type BomLineInput,
  type InfraPlan,
  type PlanStatus,
} from '@/lib/estate-queries';
import { localizedHref } from '@/lib/locale-path';
import { useFormatters, useT } from '@/providers';

export interface AssetsViewProps {
  locale: Locale;
}

/** Plan status transitions an operator may make, in display order. */
export const PLAN_NEXT: Record<PlanStatus, readonly PlanStatus[]> = {
  draft: ['approved', 'cancelled'],
  approved: ['building', 'cancelled'],
  building: ['live', 'cancelled'],
  live: [],
  cancelled: [],
};

const planState = {
  draft: 'unknown',
  approved: 'at_risk',
  building: 'degraded',
  live: 'healthy',
  cancelled: 'down',
} as const;

function coverDates(a: AssetRecord): number[] {
  return [a.warrantyEndsAt, a.endOfSupport, a.supportContract?.endsAt ?? null]
    .filter((d): d is string => d !== null)
    .map((d) => new Date(d).getTime());
}

function endsBy(times: ReadonlyArray<number>, limit: number): boolean {
  return times.some((time) => limit >= time);
}

/** Assets whose warranty or support ends within `days` from `now`, soonest first. */
export function needsAttention(assets: ReadonlyArray<AssetRecord>, days: number, now: Date): AssetRecord[] {
  const limit = now.getTime() + days * TIME.msPerDay;
  const soonest = (a: AssetRecord): number => Math.min(...coverDates(a));
  return assets.filter((a) => endsBy(coverDates(a), limit)).sort((a, b) => soonest(a) - soonest(b));
}

function stageKey(stage: AssetStage): MessageKey {
  return ('assets.stage.' + stage) as MessageKey;
}

function statusKey(status: PlanStatus): MessageKey {
  return ('assets.plans.status.' + status) as MessageKey;
}

function money(
  format: ReturnType<typeof useFormatters>,
  m: { amount: number; currency: string } | null,
): string {
  return m === null ? '' : format.number(m.amount) + ' ' + m.currency;
}

export function AssetsView({ locale }: AssetsViewProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const can = useCan();
  const queryClient = useQueryClient();
  const canOperate = can(ROLES.operator);
  const [stage, setStage] = useState<AssetStage | ''>('');
  const [horizon, setHorizon] = useState<number>(ASSETS.defaultWarrantyHorizonDays);
  const assets = useQuery(assetsQuery({ stage: stage === '' ? null : [stage] }));
  const expiring = useQuery(assetsQuery({ warrantyExpiringWithinDays: horizon }));
  const plans = useQuery(plansQuery());
  const stageMutation = useMutation({
    mutationFn: ({ assetId, next }: { assetId: string; next: AssetStage }) => setAssetStage(assetId, next),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['assets'] });
      await queryClient.invalidateQueries({ queryKey: ['plans'] });
    },
  });
  const statusMutation = useMutation({
    mutationFn: ({ planId, next }: { planId: string; next: PlanStatus }) => setPlanStatus(planId, next),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['plans'] });
      await queryClient.invalidateQueries({ queryKey: ['assets'] });
    },
  });

  const list = assets.data ?? [];
  const attention = useMemo(
    () => needsAttention(expiring.data ?? [], horizon, new Date()),
    [expiring.data, horizon],
  );
  const byStage = useMemo(() => {
    const counts = new Map<AssetStage, number>();
    for (const a of list) counts.set(a.stage, (counts.get(a.stage) ?? 0) + 1);
    return counts;
  }, [list]);

  const ciHref = (id: string): string => localizedHref(locale, '/cmdb/' + encodeURIComponent(id));

  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle as="h1" size="lg" eyebrow={t('app.name')} description={t('assets.subtitle')}>
        {t('assets.title')}
      </SectionTitle>

      <div className="grid grid-cols-2 gap-om-12 md:grid-cols-4">
        <Kpi label={t('assets.kpi.shown')} value={format.integer(list.length)} />
        <Kpi label={t('assets.stage.deployed')} value={format.integer(byStage.get('deployed') ?? 0)} />
        <Kpi
          label={t('assets.kpi.attention', { days: format.integer(horizon) })}
          value={format.integer(attention.length)}
          delta={attention.length}
          deltaLabel=""
          lowerIsBetter
        />
        <Kpi label={t('assets.stage.rma')} value={format.integer(byStage.get('rma') ?? 0)} />
      </div>

      <Card padding="24" className="flex flex-col gap-om-16">
        <SectionTitle
          as="h2"
          size="sm"
          description={t('assets.attention.subtitle')}
          action={
            <label className="flex items-center gap-om-8 text-om-xs text-om-secondary">
              <span>{t('assets.attention.horizon')}</span>
              <Select
                value={horizon}
                onChange={(event) => {
                  setHorizon(Number(event.target.value));
                }}
                className="w-auto"
              >
                {ASSETS.warrantyHorizonsDays.map((days) => (
                  <option key={days} value={days}>
                    {t('assets.attention.days', { days: format.integer(days) })}
                  </option>
                ))}
              </Select>
            </label>
          }
        >
          {t('assets.attention.title')}
        </SectionTitle>
        <div className="h-[14rem] overflow-y-auto">
          {expiring.isPending ? (
            <QueryState status="pending" />
          ) : expiring.isError ? (
            <QueryState
              status="error"
              onRetry={() => {
                void expiring.refetch();
              }}
            />
          ) : attention.length === 0 ? (
            <p className="text-om-sm text-om-secondary">{t('assets.attention.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead className={theadClass}>
                  <tr>
                    <th scope="col" className={thClass}>
                      {t('assets.table.tag')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('assets.table.hardware')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('assets.table.warranty')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('assets.table.endOfSupport')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('assets.table.contract')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {attention.map((a) => (
                    <tr key={a.id} className={rowClass}>
                      <td className={tdClass + ' font-om-mono text-om-primary'}>{a.assetTag}</td>
                      <td className={tdClass + ' text-om-secondary'}>{a.manufacturer + ' ' + a.model}</td>
                      <td className={tdClass + ' whitespace-nowrap text-om-amber'}>
                        {a.warrantyEndsAt === null ? t('common.none') : format.dateTime(a.warrantyEndsAt)}
                      </td>
                      <td className={tdClass + ' whitespace-nowrap text-om-secondary'}>
                        {a.endOfSupport === null ? t('common.none') : format.dateTime(a.endOfSupport)}
                      </td>
                      <td className={tdClass + ' text-om-secondary'}>
                        {a.supportContract === null
                          ? t('common.none')
                          : a.supportContract.contractNumber +
                            ' · ' +
                            a.supportContract.level +
                            ' · ' +
                            format.dateTime(a.supportContract.endsAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      <Card padding="24" className="flex flex-col gap-om-16">
        <SectionTitle
          as="h2"
          size="sm"
          description={t('assets.register.subtitle')}
          action={
            <label className="flex items-center gap-om-8 text-om-xs text-om-secondary">
              <span>{t('assets.filter.stage')}</span>
              <Select
                value={stage}
                onChange={(event) => {
                  setStage(event.target.value as AssetStage | '');
                }}
                className="w-auto"
              >
                <option value="">{t('assets.filter.allStages')}</option>
                {ASSET_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {t(stageKey(s))}
                  </option>
                ))}
              </Select>
            </label>
          }
        >
          {t('assets.register.title')}
        </SectionTitle>
        <div className="h-[24rem] overflow-y-auto">
          {assets.isPending ? (
            <QueryState status="pending" />
          ) : assets.isError ? (
            <QueryState
              status="error"
              onRetry={() => {
                void assets.refetch();
              }}
            />
          ) : list.length === 0 ? (
            <p className="text-om-sm text-om-secondary">{t('assets.register.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead className={theadClass}>
                  <tr>
                    <th scope="col" className={thClass}>
                      {t('assets.table.tag')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('assets.table.hardware')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('assets.table.ci')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('assets.table.stage')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('assets.table.plan')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('assets.table.cost')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((a) => (
                    <tr key={a.id} className={rowClass}>
                      <td className={tdClass + ' font-om-mono text-om-primary'}>
                        {a.assetTag}
                        {a.serialNumber !== null ? (
                          <span className="block text-om-2xs text-om-muted">{a.serialNumber}</span>
                        ) : null}
                      </td>
                      <td className={tdClass + ' text-om-secondary'}>{a.manufacturer + ' ' + a.model}</td>
                      <td className={tdClass}>
                        {a.ci === null ? (
                          <span className="text-om-muted">{t('common.none')}</span>
                        ) : (
                          <Link href={ciHref(a.ci.id)} className="text-om-cyan hover:underline">
                            {a.ci.displayName}
                          </Link>
                        )}
                      </td>
                      <td className={tdClass}>
                        {canOperate ? (
                          <Select
                            aria-label={t('assets.setStage', { tag: a.assetTag })}
                            value={a.stage}
                            disabled={stageMutation.isPending}
                            onChange={(event) => {
                              stageMutation.mutate({ assetId: a.id, next: event.target.value as AssetStage });
                            }}
                            className="w-auto"
                          >
                            {ASSET_STAGES.map((s) => (
                              <option key={s} value={s}>
                                {t(stageKey(s))}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <Tag>{t(stageKey(a.stage))}</Tag>
                        )}
                      </td>
                      <td className={tdClass + ' text-om-secondary'}>
                        {a.plan === null ? t('common.none') : a.plan.number + ' · ' + a.plan.name}
                      </td>
                      <td className={tdClass + ' font-om-mono text-om-secondary'}>
                        {money(format, a.purchaseCost)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      <Card padding="24" className="flex flex-col gap-om-16">
        <SectionTitle
          as="h2"
          size="sm"
          description={t('assets.plans.subtitle')}
          action={<Icon name="assets" className="size-5 text-om-violet" />}
        >
          {t('assets.plans.title')}
        </SectionTitle>
        {plans.isPending ? (
          <QueryState status="pending" />
        ) : plans.isError ? (
          <QueryState
            status="error"
            onRetry={() => {
              void plans.refetch();
            }}
          />
        ) : plans.data.length === 0 ? (
          <p className="text-om-sm text-om-secondary">{t('assets.plans.empty')}</p>
        ) : (
          <div className="flex flex-col gap-om-12">
            {plans.data.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                canOperate={canOperate}
                busy={statusMutation.isPending}
                onStatus={(next) => {
                  statusMutation.mutate({ planId: plan.id, next });
                }}
              />
            ))}
          </div>
        )}
        {canOperate ? (
          <NewPlanForm
            onCreated={() => {
              void queryClient.invalidateQueries({ queryKey: ['plans'] });
              void queryClient.invalidateQueries({ queryKey: ['assets'] });
            }}
          />
        ) : (
          <p className="text-om-xs text-om-muted">{t('assets.plans.readOnly')}</p>
        )}
      </Card>
    </div>
  );
}

interface PlanCardProps {
  plan: InfraPlan;
  canOperate: boolean;
  busy: boolean;
  onStatus: (next: PlanStatus) => void;
}

function PlanCard({ plan, canOperate, busy, onStatus }: PlanCardProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const next = PLAN_NEXT[plan.status];
  return (
    <article
      className="flex flex-col gap-om-10 rounded-om-panel border border-om-border-glass bg-om-surface2 p-om-16"
      aria-label={plan.number + ' ' + plan.name}
    >
      <div className="flex flex-wrap items-center gap-om-10">
        <span className="font-om-mono text-om-xs text-om-muted">{plan.number}</span>
        <h3 className="font-om-display text-om-sm font-semibold text-om-primary">{plan.name}</h3>
        <Tag>{t(('assets.plans.kind.' + plan.kind) as MessageKey)}</Tag>
        <StateBadge state={planState[plan.status]} label={t(statusKey(plan.status))} />
        <span className="ms-auto text-om-xs text-om-secondary">
          {t('assets.plans.assets', { count: format.integer(plan.assets.length) })}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className={tableClass}>
          <thead className={theadClass}>
            <tr>
              <th scope="col" className={thClass}>
                {t('assets.plans.bom.description')}
              </th>
              <th scope="col" className={thClass}>
                {t('assets.plans.bom.layer')}
              </th>
              <th scope="col" className={thClass}>
                {t('assets.plans.bom.quantity')}
              </th>
              <th scope="col" className={thClass}>
                {t('assets.plans.bom.received')}
              </th>
              <th scope="col" className={thClass}>
                {t('assets.plans.bom.unitCost')}
              </th>
            </tr>
          </thead>
          <tbody>
            {plan.bom.map((line, index) => (
              <tr key={index} className={rowClass}>
                <td className={tdClass + ' text-om-primary'}>
                  {line.description}
                  <span className="block text-om-2xs text-om-muted">
                    {[line.manufacturer, line.model, line.sku]
                      .filter((v) => v !== null && v !== '')
                      .join(' · ')}
                  </span>
                </td>
                <td className={tdClass}>
                  <Pill
                    icon={
                      <span
                        className="inline-block size-2 rounded-full"
                        style={{ background: layerColor(line.layer) }}
                      />
                    }
                  >
                    {t(('layer.' + line.layer) as MessageKey)}
                  </Pill>
                </td>
                <td className={tdClass + ' font-om-mono text-om-secondary'}>
                  {format.integer(line.quantity)}
                </td>
                <td className={tdClass + ' font-om-mono text-om-secondary'}>
                  {format.integer(line.received)}
                </td>
                <td className={tdClass + ' font-om-mono text-om-secondary'}>
                  {money(format, line.unitCost)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-om-10 text-om-xs text-om-secondary">
        <span>
          {t('assets.plans.estimated', { cost: money(format, plan.estimatedCost) || t('common.none') })}
        </span>
        {plan.targetSite !== null ? (
          <span>{t('assets.plans.site', { site: plan.targetSite.displayName })}</span>
        ) : null}
        {plan.plannedLiveAt !== null ? (
          <span>{t('assets.plans.liveAt', { when: format.dateTime(plan.plannedLiveAt) })}</span>
        ) : null}
        {canOperate && next.length > 0 ? (
          <span className="ms-auto flex gap-om-6">
            {next.map((status) => (
              <Button
                key={status}
                tone={status === 'cancelled' ? 'danger' : 'primary'}
                disabled={busy}
                onClick={() => {
                  onStatus(status);
                }}
              >
                {t(('assets.plans.to.' + status) as MessageKey)}
              </Button>
            ))}
          </span>
        ) : null}
      </div>
    </article>
  );
}

interface NewPlanFormProps {
  onCreated: () => void;
}

interface LineDraft {
  description: string;
  manufacturer: string;
  model: string;
  sku: string;
  layer: CiLayer;
  quantity: string;
  unitCostAmount: string;
  unitCostCurrency: string;
}

const emptyLine = (): LineDraft => ({
  description: '',
  manufacturer: '',
  model: '',
  sku: '',
  layer: 'hardware',
  quantity: '1',
  unitCostAmount: '',
  unitCostCurrency: '',
});

/** Form lines → contract input; blank optional fields are omitted rather than sent empty. */
export function toBomInput(lines: ReadonlyArray<LineDraft>): BomLineInput[] {
  return lines
    .filter((l) => l.description.trim() !== '')
    .map((l) => {
      const out: BomLineInput = {
        description: l.description.trim(),
        layer: l.layer,
        quantity: Math.max(1, Math.floor(Number(l.quantity) || 1)),
      };
      if (l.manufacturer.trim() !== '') out.manufacturer = l.manufacturer.trim();
      if (l.model.trim() !== '') out.model = l.model.trim();
      if (l.sku.trim() !== '') out.sku = l.sku.trim();
      if (l.unitCostAmount.trim() !== '' && Number.isFinite(Number(l.unitCostAmount))) {
        out.unitCostAmount = Number(l.unitCostAmount);
        if (l.unitCostCurrency.trim() !== '') out.unitCostCurrency = l.unitCostCurrency.trim().toUpperCase();
      }
      return out;
    });
}

function NewPlanForm({ onCreated }: NewPlanFormProps): ReactNode {
  const t = useT();
  const id = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<(typeof PLAN_KINDS)[number]>(PLAN_KINDS[0]);
  const [liveAt, setLiveAt] = useState('');
  const [lines, setLines] = useState<LineDraft[]>(() =>
    Array.from({ length: ASSETS.initialBomLines }, emptyLine),
  );
  const [created, setCreated] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: createPlan,
    onSuccess: (plan) => {
      setCreated(plan.number);
      setName('');
      setDescription('');
      setLiveAt('');
      setLines([emptyLine()]);
      onCreated();
    },
  });
  const bom = toBomInput(lines);
  const valid = name.trim() !== '' && description.trim() !== '' && bom.length > 0;

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!valid) return;
    setCreated(null);
    const input: Parameters<typeof createPlan>[0] = {
      name: name.trim(),
      description: description.trim(),
      kind,
      bom,
    };
    if (liveAt !== '') input.plannedLiveAt = new Date(liveAt).toISOString();
    mutation.mutate(input);
  };
  const updateLine = (index: number, patch: Partial<LineDraft>): void => {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  };

  return (
    <form
      onSubmit={onSubmit}
      aria-label={t('assets.plans.new')}
      className="flex flex-col gap-om-12 rounded-om-panel border border-dashed border-om-border-strong p-om-16"
    >
      <h3 className="font-om-display text-om-sm font-semibold text-om-primary">{t('assets.plans.new')}</h3>
      <div className="grid grid-cols-1 gap-om-12 md:grid-cols-3">
        <Field id={id + '-name'} label={t('assets.plans.name')}>
          <TextInput
            id={id + '-name'}
            value={name}
            required
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>
        <Field id={id + '-kind'} label={t('assets.plans.kindLabel')}>
          <Select
            id={id + '-kind'}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as (typeof PLAN_KINDS)[number]);
            }}
          >
            {PLAN_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(('assets.plans.kind.' + k) as MessageKey)}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={id + '-live'} label={t('assets.plans.liveAtLabel')}>
          <TextInput
            id={id + '-live'}
            type="date"
            value={liveAt}
            onChange={(event) => {
              setLiveAt(event.target.value);
            }}
          />
        </Field>
      </div>
      <Field id={id + '-description'} label={t('assets.plans.description')}>
        <TextArea
          id={id + '-description'}
          value={description}
          required
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
      </Field>
      <div className="flex flex-col gap-om-8">
        <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
          {t('assets.plans.bomTitle')}
        </span>
        {lines.map((line, index) => (
          <div key={index} className="grid grid-cols-2 gap-om-8 md:grid-cols-8">
            <TextInput
              aria-label={t('assets.plans.bom.description')}
              value={line.description}
              onChange={(event) => {
                updateLine(index, { description: event.target.value });
              }}
              className="md:col-span-2"
            />
            <TextInput
              aria-label={t('assets.plans.bom.manufacturer')}
              value={line.manufacturer}
              onChange={(event) => {
                updateLine(index, { manufacturer: event.target.value });
              }}
            />
            <TextInput
              aria-label={t('assets.plans.bom.model')}
              value={line.model}
              onChange={(event) => {
                updateLine(index, { model: event.target.value });
              }}
            />
            <Select
              aria-label={t('assets.plans.bom.layer')}
              value={line.layer}
              onChange={(event) => {
                updateLine(index, { layer: event.target.value as CiLayer });
              }}
            >
              {CI_LAYERS.map((layer) => (
                <option key={layer} value={layer}>
                  {t(('layer.' + layer) as MessageKey)}
                </option>
              ))}
            </Select>
            <TextInput
              aria-label={t('assets.plans.bom.quantity')}
              type="number"
              min={1}
              step={1}
              value={line.quantity}
              onChange={(event) => {
                updateLine(index, { quantity: event.target.value });
              }}
            />
            <TextInput
              aria-label={t('assets.plans.bom.unitCost')}
              inputMode="decimal"
              value={line.unitCostAmount}
              onChange={(event) => {
                updateLine(index, { unitCostAmount: event.target.value });
              }}
            />
            <TextInput
              aria-label={t('assets.plans.bom.currency')}
              value={line.unitCostCurrency}
              onChange={(event) => {
                updateLine(index, { unitCostCurrency: event.target.value });
              }}
            />
          </div>
        ))}
        <div className="flex gap-om-8">
          <Button
            tone="quiet"
            onClick={() => {
              setLines((current) => [...current, emptyLine()]);
            }}
          >
            {t('assets.plans.addLine')}
          </Button>
          {lines.length > 1 ? (
            <Button
              tone="quiet"
              onClick={() => {
                setLines((current) => current.slice(0, -1));
              }}
            >
              {t('assets.plans.removeLine')}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-om-12">
        <Button type="submit" disabled={!valid || mutation.isPending}>
          {mutation.isPending ? t('assets.plans.creating') : t('assets.plans.create')}
        </Button>
        {created !== null ? (
          <p role="status" className="text-om-xs text-om-emerald">
            {t('assets.plans.created', { number: created })}
          </p>
        ) : null}
        {mutation.isError ? (
          <p role="alert" className="text-om-xs text-om-rose">
            {t('assets.plans.error')}
          </p>
        ) : null}
      </div>
    </form>
  );
}
