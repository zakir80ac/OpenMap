'use client';
// REQ-UI-009 REQ-CMDB-030 REQ-CMDB-039 REQ-CMDB-040 — Assets: the register of everything the organisation owns across
// every layer (ADR-023) with its warranty, support and end-of-life cover and the rows still missing a date; the
// attention table (cover ending within the chosen horizon); unknown devices with their diagnosis and remediation;
// manual entry for unmanaged equipment; and infrastructure plans with their bill of materials (ADR-005: plans, not
// purchase orders). Operators edit details, change stages and create plans; everyone else reads.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ASSETS, ROLES, TIME } from '@openmap/constants';
import { CI_LAYERS, PLAN_KINDS, type CiLayer } from '@openmap/contracts';
import type { Locale, MessageKey } from '@openmap/i18n';
import { Card, Kpi, LayerBadge, Pill, SectionTitle, StateBadge, Tag, layerColor } from '@openmap/ui';
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
  ASSET_DATA_GAPS,
  ASSET_STAGES,
  assetSummaryQuery,
  assetsAfter,
  assetsQuery,
  createPlan,
  plansQuery,
  setAssetStage,
  setPlanStatus,
  type AssetDataGap,
  type AssetRecord,
  type AssetSource,
  type AssetStage,
  type AssetsFilter,
  type BomLineInput,
  type InfraPlan,
  type PlanStatus,
} from '@/lib/estate-queries';
import { layerKey } from '@/lib/keys';
import { localizedHref } from '@/lib/locale-path';
import { useFormatters, useT } from '@/providers';
import { AssetDetailsPanel } from './AssetDetailsPanel';
import { ManualAssetForm } from './ManualAssetForm';
import { UnknownDevices } from './UnknownDevices';

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

const ASSET_SOURCES: readonly AssetSource[] = ['plan', 'discovery', 'manual'];
/** Register layers in display order: the contract's order without `unknown`, which has its own section. */
const REGISTER_LAYERS: readonly CiLayer[] = CI_LAYERS.filter((layer) => layer !== 'unknown');
/** The "Data" filter: every row, any gap, or one specific gap. */
type DataFilter = '' | 'any' | AssetDataGap;

function coverDates(a: AssetRecord): number[] {
  return [a.warrantyEndsAt, a.endOfSupport, a.supportEndsAt]
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

/** The item column: make and model when known, else the CI type, so a software instance still reads as something. */
function itemLabel(a: AssetRecord): string {
  const parts = [a.manufacturer, a.model].filter((v): v is string => v !== null);
  return parts.length > 0 ? parts.join(' ') : (a.ciType ?? '');
}

interface CoverCellProps {
  endsAt: string | null;
  now: number;
  missingLabel: string;
  expiredLabel: string;
  format: ReturnType<typeof useFormatters>;
}

/** A cover date: missing in the warning tone, past in the down tone, otherwise the date. */
function CoverCell({ endsAt, now, missingLabel, expiredLabel, format }: CoverCellProps): ReactNode {
  if (endsAt === null) return <Tag variant="state" state="at_risk">{missingLabel}</Tag>;
  const expired = new Date(endsAt).getTime() < now;
  return (
    <span className={'font-om-mono tabular-nums ' + (expired ? 'text-om-state-down' : 'text-om-secondary')} title={expired ? expiredLabel : undefined}>
      {format.date(endsAt)}
    </span>
  );
}

export function AssetsView({ locale }: AssetsViewProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const can = useCan();
  const queryClient = useQueryClient();
  const canOperate = can(ROLES.operator);
  const searchId = useId();
  const [stage, setStage] = useState<AssetStage | ''>('');
  const [layer, setLayer] = useState<CiLayer | ''>('');
  const [source, setSource] = useState<AssetSource | ''>('');
  const [data, setData] = useState<DataFilter>('');
  const [text, setText] = useState('');
  const [horizon, setHorizon] = useState<number>(ASSETS.defaultWarrantyHorizonDays);
  // The selected row is kept as a record, not an id: after a save it may leave the current filter (a gap filled) and
  // the panel must stay open showing the saved result.
  const [selected, setSelected] = useState<AssetRecord | null>(null);
  const [more, setMore] = useState<AssetRecord[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  // A page shorter than the page size is the last one; a failed page keeps the button as a retry.
  const [exhausted, setExhausted] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const filter = useMemo<AssetsFilter>(
    () => ({
      stage: stage === '' ? null : [stage],
      layers: layer === '' ? null : [layer],
      sources: source === '' ? null : [source],
      dataGaps: data === '' ? null : data === 'any' ? [...ASSET_DATA_GAPS] : [data],
      text: text.trim() === '' ? null : text.trim(),
    }),
    [stage, layer, source, data, text],
  );
  const assets = useQuery(assetsQuery(filter, ASSETS.registerPageSize));
  const summary = useQuery(assetSummaryQuery());
  const expiring = useQuery(assetsQuery({ warrantyExpiringWithinDays: horizon }));
  const plans = useQuery(plansQuery());
  const stageMutation = useMutation({
    mutationFn: ({ assetId, next }: { assetId: string; next: AssetStage }) => setAssetStage(assetId, next),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['assets'] });
      await queryClient.invalidateQueries({ queryKey: ['assetSummary'] });
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

  // The filter's first page comes from the query cache; pages loaded on demand are appended until the filter changes.
  const firstPage = assets.data ?? [];
  const list = useMemo(() => {
    const seen = new Set(firstPage.map((a) => a.id));
    return [...firstPage, ...more.filter((a) => !seen.has(a.id))];
  }, [firstPage, more]);
  const hasMore = !exhausted && firstPage.length >= ASSETS.registerPageSize;
  const loadMore = async (): Promise<void> => {
    const last = list[list.length - 1];
    if (last === undefined) return;
    setLoadingMore(true);
    try {
      const page = await assetsAfter(filter, last.id, ASSETS.registerPageSize);
      setMore((current) => [...current, ...page]);
      if (page.length < ASSETS.registerPageSize) setExhausted(true);
      setMoreFailed(false);
    } catch {
      setMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };
  const resetPages = (): void => {
    setMore([]);
    setExhausted(false);
    setMoreFailed(false);
    setSelected(null);
  };
  const now = useMemo(() => Date.now(), []);
  const attention = useMemo(
    () => needsAttention(expiring.data ?? [], horizon, new Date(now)),
    [expiring.data, horizon, now],
  );
  const totals = useMemo(() => {
    const rows = summary.data ?? [];
    const sum = (pick: (row: (typeof rows)[number]) => number): number => rows.reduce((acc, row) => acc + pick(row), 0);
    return { owned: sum((r) => r.count), needsData: sum((r) => r.needsData), warrantyExpired: sum((r) => r.warrantyExpired), supportExpired: sum((r) => r.supportExpired), eolPassed: sum((r) => r.endOfSupportPassed) };
  }, [summary.data]);
  const byLayer = useMemo(() => new Map((summary.data ?? []).map((row) => [row.layer, row])), [summary.data]);
  const selectedAsset = selected === null ? null : (list.find((a) => a.id === selected.id) ?? selected);

  const ciHref = (id: string): string => localizedHref(locale, '/cmdb/' + encodeURIComponent(id));

  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle as="h1" size="lg" eyebrow={t('app.name')} description={t('assets.subtitle')}>
        {t('assets.title')}
      </SectionTitle>

      <div className="grid grid-cols-2 gap-om-12 md:grid-cols-5">
        <Kpi label={t('assets.kpi.owned')} value={format.integer(totals.owned)} />
        <Kpi label={t('assets.kpi.needsData')} value={format.integer(totals.needsData)} delta={totals.needsData} deltaLabel="" lowerIsBetter />
        <Kpi label={t('assets.kpi.warrantyExpired')} value={format.integer(totals.warrantyExpired)} delta={totals.warrantyExpired} deltaLabel="" lowerIsBetter />
        <Kpi label={t('assets.kpi.supportExpired')} value={format.integer(totals.supportExpired)} delta={totals.supportExpired} deltaLabel="" lowerIsBetter />
        <Kpi label={t('assets.kpi.eolPassed')} value={format.integer(totals.eolPassed)} delta={totals.eolPassed} deltaLabel="" lowerIsBetter />
      </div>

      <Card padding="24" className="flex flex-col gap-om-16">
        <SectionTitle as="h2" size="sm" description={t('assets.register.subtitle')}>
          {t('assets.register.title')}
        </SectionTitle>
        {/* Layer strip: one pill per layer with its register count; the active one filters the table. */}
        <div className="flex flex-wrap gap-om-6" role="group" aria-label={t('assets.register.layers')} data-testid="asset-layer-strip">
          <Pill
            variant={layer === '' ? 'primary' : 'default'}
            onClick={() => {
              setLayer('');
              resetPages();
            }}
          >
            {t('assets.register.all')} · {format.integer(totals.owned)}
          </Pill>
          {REGISTER_LAYERS.map((candidate) => {
            const row = byLayer.get(candidate);
            return (
              <Pill
                key={candidate}
                variant={layer === candidate ? 'primary' : 'default'}
                icon={<span aria-hidden="true" className="size-2 rounded-om-pill" style={{ background: layerColor(candidate) }} />}
                onClick={() => {
                  setLayer(layer === candidate ? '' : candidate);
                  resetPages();
                }}
              >
                {t(layerKey(candidate))} · {format.integer(row?.count ?? 0)}
                {row !== undefined && row.needsData > 0 ? <span className="ms-om-4 text-om-state-degraded">({format.integer(row.needsData)})</span> : null}
              </Pill>
            );
          })}
        </div>
        <div className="flex flex-wrap items-end gap-om-10">
          <Field id={searchId} label={t('assets.filter.text')} className="min-w-[16rem] flex-1">
            <TextInput
              id={searchId}
              type="search"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                resetPages();
              }}
            />
          </Field>
          <label className="flex flex-col gap-om-4 text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
            <span>{t('assets.filter.data')}</span>
            <Select
              value={data}
              onChange={(event) => {
                setData(event.target.value as DataFilter);
                resetPages();
              }}
              className="w-auto"
            >
              <option value="">{t('assets.filter.allData')}</option>
              <option value="any">{t('assets.filter.anyGap')}</option>
              {ASSET_DATA_GAPS.map((gap) => (
                <option key={gap} value={gap}>
                  {t(`assets.filter.gap.${gap}`)}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-om-4 text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
            <span>{t('assets.filter.stage')}</span>
            <Select
              value={stage}
              onChange={(event) => {
                setStage(event.target.value as AssetStage | '');
                resetPages();
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
          <label className="flex flex-col gap-om-4 text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
            <span>{t('assets.filter.source')}</span>
            <Select
              value={source}
              onChange={(event) => {
                setSource(event.target.value as AssetSource | '');
                resetPages();
              }}
              className="w-auto"
            >
              <option value="">{t('assets.filter.allSources')}</option>
              {ASSET_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {t(`assets.source.${s}`)}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <div className="max-h-[32rem] overflow-y-auto">
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
              <table className={tableClass} data-testid="asset-register">
                <thead className={theadClass}>
                  <tr>
                    <th scope="col" className={thClass}>
                      {t('assets.table.tag')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('assets.table.item')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('assets.table.layer')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('assets.table.ci')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('assets.table.stage')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('assets.table.warranty')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('assets.table.support')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('assets.table.endOfSupport')}
                    </th>
                    <th scope="col" className={thClass}>
                      <span className="sr-only">{t('assets.table.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((a) => (
                    <tr key={a.id} className={rowClass} data-asset-tag={a.assetTag} data-selected={selected?.id === a.id ? 'true' : undefined}>
                      <td className={tdClass + ' font-om-mono text-om-primary'}>
                        {a.assetTag}
                        {a.serialNumber !== null ? (
                          <span className="block text-om-2xs text-om-muted">{a.serialNumber}</span>
                        ) : null}
                      </td>
                      <td className={tdClass + ' text-om-secondary'}>
                        {itemLabel(a)}
                        {a.ciType !== null && itemLabel(a) !== a.ciType ? <span className="block text-om-2xs text-om-muted">{a.ciType}</span> : null}
                      </td>
                      <td className={tdClass}>
                        <LayerBadge layer={a.layer} label={t(layerKey(a.layer))} />
                      </td>
                      <td className={tdClass}>
                        {a.ci === null ? (
                          <span className="text-om-muted">{a.plan === null ? t('common.none') : a.plan.number}</span>
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
                      <td className={tdClass}>
                        <CoverCell endsAt={a.warrantyEndsAt} now={now} missingLabel={t('assets.table.missing')} expiredLabel={t('assets.table.expired')} format={format} />
                      </td>
                      <td className={tdClass}>
                        <CoverCell endsAt={a.supportEndsAt} now={now} missingLabel={t('assets.table.missing')} expiredLabel={t('assets.table.expired')} format={format} />
                      </td>
                      <td className={tdClass}>
                        <CoverCell endsAt={a.endOfSupport} now={now} missingLabel={t('assets.table.missing')} expiredLabel={t('assets.table.expired')} format={format} />
                      </td>
                      <td className={tdClass}>
                        <Button
                          tone={selected?.id === a.id ? 'primary' : 'quiet'}
                          aria-label={t('assets.table.edit', { tag: a.assetTag })}
                          aria-pressed={selected?.id === a.id}
                          onClick={() => {
                            setSelected((current) => (current?.id === a.id ? null : a));
                          }}
                        >
                          <Icon name="tag" className="size-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-om-10 text-om-xs text-om-secondary">
          <span>{t('assets.table.showing', { count: format.integer(list.length) })}</span>
          {moreFailed ? (
            <span role="alert" className="text-om-danger">
              {t('common.error')}
            </span>
          ) : null}
          {hasMore ? (
            <Button
              tone="quiet"
              disabled={loadingMore}
              onClick={() => {
                void loadMore();
              }}
            >
              {loadingMore ? t('common.loading') : moreFailed ? t('common.retry') : t('common.more')}
            </Button>
          ) : null}
        </div>
        {selectedAsset !== null ? (
          <AssetDetailsPanel
            key={selectedAsset.id}
            asset={selectedAsset}
            canEdit={canOperate}
            onClose={() => {
              setSelected(null);
            }}
            onSaved={setSelected}
          />
        ) : null}
      </Card>

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
                      {t('assets.table.item')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('assets.table.warranty')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('assets.table.support')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('assets.table.endOfSupport')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {attention.map((a) => (
                    <tr key={a.id} className={rowClass}>
                      <td className={tdClass + ' font-om-mono text-om-primary'}>{a.assetTag}</td>
                      <td className={tdClass + ' text-om-secondary'}>{itemLabel(a)}</td>
                      <td className={tdClass}>
                        <CoverCell endsAt={a.warrantyEndsAt} now={now} missingLabel={t('assets.table.missing')} expiredLabel={t('assets.table.expired')} format={format} />
                      </td>
                      <td className={tdClass}>
                        <CoverCell endsAt={a.supportEndsAt} now={now} missingLabel={t('assets.table.missing')} expiredLabel={t('assets.table.expired')} format={format} />
                      </td>
                      <td className={tdClass}>
                        <CoverCell endsAt={a.endOfSupport} now={now} missingLabel={t('assets.table.missing')} expiredLabel={t('assets.table.expired')} format={format} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      <UnknownDevices canOperate={canOperate} />

      {canOperate ? (
        <ManualAssetForm
          onCreated={() => {
            resetPages();
          }}
        />
      ) : null}

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
              void queryClient.invalidateQueries({ queryKey: ['assetSummary'] });
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
