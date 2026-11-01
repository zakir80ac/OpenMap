'use client';
// REQ-UI-014 REQ-INT-005 — Integrations: health KPIs, the catalogue of categories as a filter, every configured
// integration with its health and last-hour deliveries, a detail panel with configuration, field and class mappings
// and recent deliveries, a probe (testIntegration) and an editor (upsertIntegration). Administrators change things;
// operators read details; analysts see the list.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLES } from '@openmap/constants';
import { DIRECTIONS, EVENT_TYPES, INTEGRATION_CATEGORIES, INTEGRATION_VENDORS } from '@openmap/contracts';
import type { MessageKey } from '@openmap/i18n';
import { Card, Kpi, Pill, SectionTitle, StateBadge, Tag, type UiState } from '@openmap/ui';
import { useId, useMemo, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Button, Field, Select, TextInput, rowClass, tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { Icon } from '@/components/icons';
import { useCan } from '@/lib/auth';
import { integrationDeliveriesQuery, integrationQuery, integrationsQuery, testIntegration, upsertIntegration, type ClassMapping, type FieldMapping, type Integration, type IntegrationDetail, type IntegrationHealth, type IntegrationInput } from '@/lib/estate-queries';
import { useFormatters, useT } from '@/providers';

export const HEALTH_STATE: Record<IntegrationHealth, UiState> = { healthy: 'healthy', warning: 'degraded', failing: 'down', disabled: 'unknown' };

function healthKey(health: IntegrationHealth): MessageKey {
  return ('integrations.health.' + health) as MessageKey;
}

function categoryKey(category: string): MessageKey {
  return ('integrations.category.' + category) as MessageKey;
}

function directionKey(direction: string): MessageKey {
  return ('integrations.direction.' + direction) as MessageKey;
}

export function IntegrationsView(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const can = useCan();
  const queryClient = useQueryClient();
  const canAdmin = can(ROLES.admin);
  const canOperate = can(ROLES.operator);
  const [category, setCategory] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<IntegrationDetail | 'new' | null>(null);
  const integrations = useQuery(integrationsQuery(category === '' ? null : category));

  const list = integrations.data ?? [];
  const totals = useMemo(() => {
    const counts: Record<IntegrationHealth, number> = { healthy: 0, warning: 0, failing: 0, disabled: 0 };
    let delivered = 0;
    for (const i of list) {
      counts[i.health] += 1;
      delivered += i.deliveredLastHour;
    }
    return { counts, delivered };
  }, [list]);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['integrations'] });
    void queryClient.invalidateQueries({ queryKey: ['integration'] });
    void queryClient.invalidateQueries({ queryKey: ['integrationDeliveries'] });
  };

  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle as="h1" size="lg" eyebrow={t('app.name')} description={t('integrations.subtitle')}>
        {t('integrations.title')}
      </SectionTitle>

      <div className="grid grid-cols-2 gap-om-12 md:grid-cols-4">
        <Kpi label={t('integrations.kpi.configured')} value={format.integer(list.length)} />
        <Kpi label={t('integrations.health.healthy')} value={format.integer(totals.counts.healthy)} />
        <Kpi label={t('integrations.health.failing')} value={format.integer(totals.counts.failing)} />
        <Kpi label={t('integrations.kpi.delivered')} value={format.integer(totals.delivered)} />
      </div>

      <Card padding="24" className="flex flex-col gap-om-16">
        <SectionTitle as="h2" size="sm" description={t('integrations.catalogue.subtitle')}>
          {t('integrations.catalogue.title')}
        </SectionTitle>
        <div className="flex flex-wrap gap-om-6" role="group" aria-label={t('integrations.catalogue.title')}>
          <Pill
            variant={category === '' ? 'primary' : 'default'}
            onClick={() => {
              setCategory('');
            }}
          >
            {t('integrations.catalogue.all')}
          </Pill>
          {INTEGRATION_CATEGORIES.map((c) => (
            <Pill
              key={c}
              variant={category === c ? 'primary' : 'default'}
              onClick={() => {
                setCategory(c);
              }}
            >
              {t(categoryKey(c))}
            </Pill>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-om-16 xl:grid-cols-[3fr_2fr]">
        <Card padding="24" className="flex flex-col gap-om-16">
          <SectionTitle
            as="h2"
            size="sm"
            description={t('integrations.list.subtitle')}
            action={
              canAdmin ? (
                <Button
                  onClick={() => {
                    setEditing('new');
                  }}
                >
                  {t('integrations.new')}
                </Button>
              ) : undefined
            }
          >
            {t('integrations.list.title')}
          </SectionTitle>
          {integrations.isPending ? (
            <QueryState status="pending" />
          ) : integrations.isError ? (
            <QueryState
              status="error"
              onRetry={() => {
                void integrations.refetch();
              }}
            />
          ) : list.length === 0 ? (
            <p className="text-om-sm text-om-secondary">{t('integrations.list.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead className={theadClass}>
                  <tr>
                    <th scope="col" className={thClass}>{t('integrations.table.name')}</th>
                    <th scope="col" className={thClass}>{t('integrations.table.vendor')}</th>
                    <th scope="col" className={thClass}>{t('integrations.table.direction')}</th>
                    <th scope="col" className={thClass}>{t('integrations.table.health')}</th>
                    <th scope="col" className={thClass}>{t('integrations.table.lastHour')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((i) => (
                    <tr key={i.id} className={rowClass + (selectedId === i.id ? ' bg-om-surface2' : '')}>
                      <td className={tdClass}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedId(i.id);
                            setEditing(null);
                          }}
                          className="text-start font-om-display text-om-sm font-semibold text-om-cyan hover:underline"
                        >
                          {i.name}
                        </button>
                        <span className="block text-om-2xs text-om-muted">{t(categoryKey(i.category))}</span>
                      </td>
                      <td className={tdClass + ' font-om-mono text-om-secondary'}>{i.vendor}</td>
                      <td className={tdClass}>
                        <Tag>{t(directionKey(i.direction))}</Tag>
                      </td>
                      <td className={tdClass}>
                        <StateBadge state={HEALTH_STATE[i.health]} label={t(healthKey(i.health))} />
                      </td>
                      <td className={tdClass + ' font-om-mono text-om-secondary'}>{format.integer(i.deliveredLastHour) + ' / ' + format.integer(i.failedLastHour)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="flex flex-col gap-om-16">
          {editing !== null && canAdmin ? (
            <IntegrationForm
              existing={editing === 'new' ? null : editing}
              onDone={(saved) => {
                setEditing(null);
                if (saved !== null) setSelectedId(saved.id);
                invalidate();
              }}
            />
          ) : selectedId !== null && canOperate ? (
            <IntegrationDetailPanel
              id={selectedId}
              canAdmin={canAdmin}
              onEdit={(detail) => {
                setEditing(detail);
              }}
              onChanged={invalidate}
            />
          ) : (
            <Card padding="24" className="flex flex-col gap-om-8">
              <SectionTitle as="h2" size="sm">
                {t('integrations.detail.title')}
              </SectionTitle>
              <p className="text-om-sm text-om-secondary">{canOperate ? t('integrations.detail.pick') : t('integrations.detail.readOnly')}</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

interface DetailProps {
  id: string;
  canAdmin: boolean;
  onEdit: (detail: IntegrationDetail) => void;
  onChanged: () => void;
}

function IntegrationDetailPanel({ id, canAdmin, onEdit, onChanged }: DetailProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const detail = useQuery(integrationQuery(id));
  const deliveries = useQuery(integrationDeliveriesQuery(id));
  const probe = useMutation({
    mutationFn: testIntegration,
    onSuccess: () => {
      onChanged();
    },
  });

  if (detail.isPending) return <QueryState status="pending" />;
  if (detail.isError)
    return (
      <QueryState
        status="error"
        onRetry={() => {
          void detail.refetch();
        }}
      />
    );
  const d = detail.data;
  return (
    <section aria-label={d.name}>
      <Card padding="24" className="flex flex-col gap-om-16">
      <SectionTitle
        as="h2"
        size="sm"
        description={d.vendor + ' · ' + t(categoryKey(d.category))}
        action={
          canAdmin ? (
            <span className="flex gap-om-6">
              <Button
                tone="quiet"
                onClick={() => {
                  onEdit(d);
                }}
              >
                {t('integrations.edit')}
              </Button>
              <Button
                disabled={probe.isPending}
                onClick={() => {
                  probe.mutate(d.id);
                }}
              >
                {probe.isPending ? t('integrations.testing') : t('integrations.test')}
              </Button>
            </span>
          ) : undefined
        }
      >
        {d.name}
      </SectionTitle>
      <dl className="grid grid-cols-1 gap-om-10 text-om-xs md:grid-cols-2">
        <div>
          <dt className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('integrations.table.health')}</dt>
          <dd>
            <StateBadge state={HEALTH_STATE[d.health]} label={t(healthKey(d.health))} />
          </dd>
        </div>
        <div>
          <dt className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('integrations.detail.lastSuccess')}</dt>
          <dd className="text-om-secondary">{d.lastSuccessAt === null ? t('common.none') : format.dateTime(d.lastSuccessAt)}</dd>
        </div>
        <div>
          <dt className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('integrations.form.endpoint')}</dt>
          <dd className="break-all font-om-mono text-om-secondary">{d.endpoint}</dd>
        </div>
        <div>
          <dt className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('integrations.form.credentialRef')}</dt>
          <dd className="font-om-mono text-om-secondary">{d.credentialRef}</dd>
        </div>
        {d.lastError !== null ? (
          <div className="md:col-span-2">
            <dt className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('integrations.detail.lastError')}</dt>
            <dd className="font-om-mono text-om-rose">{d.lastError}</dd>
          </div>
        ) : null}
      </dl>
      <div className="flex flex-col gap-om-6">
        <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('integrations.form.events')}</span>
        <div className="flex flex-wrap gap-om-6">{d.subscribedEvents.length === 0 ? <span className="text-om-xs text-om-muted">{t('common.none')}</span> : d.subscribedEvents.map((e) => <Tag key={e}>{e}</Tag>)}</div>
      </div>
      <div className="grid grid-cols-1 gap-om-12 md:grid-cols-2">
        <div className="flex flex-col gap-om-6">
          <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('integrations.mappings.fields')}</span>
          {d.fieldMappings.length === 0 ? (
            <span className="text-om-xs text-om-muted">{t('common.none')}</span>
          ) : (
            <ul className="flex flex-col gap-om-4 font-om-mono text-om-xs text-om-secondary">
              {d.fieldMappings.map((m, i) => (
                <li key={i}>{m.from + ' → ' + m.to + ' (' + m.direction + ')'}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-col gap-om-6">
          <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('integrations.mappings.classes')}</span>
          {d.classMappings.length === 0 ? (
            <span className="text-om-xs text-om-muted">{t('common.none')}</span>
          ) : (
            <ul className="flex flex-col gap-om-4 font-om-mono text-om-xs text-om-secondary">
              {d.classMappings.map((m, i) => (
                <li key={i}>{m.ciType + ' → ' + m.remoteClass}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-om-6">
        <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('integrations.deliveries.title')}</span>
        {deliveries.isPending ? (
          <QueryState status="pending" />
        ) : deliveries.isError ? (
          <QueryState status="error" />
        ) : deliveries.data.length === 0 ? (
          <span className="text-om-xs text-om-muted">{t('integrations.deliveries.empty')}</span>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead className={theadClass}>
                <tr>
                  <th scope="col" className={thClass}>{t('integrations.deliveries.when')}</th>
                  <th scope="col" className={thClass}>{t('integrations.table.direction')}</th>
                  <th scope="col" className={thClass}>{t('integrations.deliveries.state')}</th>
                  <th scope="col" className={thClass}>{t('integrations.deliveries.attempts')}</th>
                  <th scope="col" className={thClass}>{t('integrations.deliveries.response')}</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.data.map((x) => (
                  <tr key={x.id} className={rowClass}>
                    <td className={tdClass + ' whitespace-nowrap text-om-secondary'}>{format.dateTime(x.createdAt)}</td>
                    <td className={tdClass}>
                      <Tag>{x.direction}</Tag>
                    </td>
                    <td className={tdClass + ' font-om-mono text-om-primary'}>{x.state}</td>
                    <td className={tdClass + ' font-om-mono text-om-secondary'}>{format.integer(x.attempts)}</td>
                    <td className={tdClass + ' font-om-mono text-om-secondary'}>{x.responseCode === null ? (x.error ?? '') : String(x.responseCode)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {probe.isError ? (
        <p role="alert" className="text-om-xs text-om-rose">
          {t('integrations.testFailed')}
        </p>
      ) : null}
      </Card>
    </section>
  );
}

interface FormProps {
  existing: IntegrationDetail | null;
  onDone: (saved: Integration | null) => void;
}

interface FormState {
  name: string;
  category: string;
  vendor: string;
  direction: string;
  endpoint: string;
  credentialRef: string;
  events: string[];
  fieldMappings: FieldMapping[];
  classMappings: ClassMapping[];
}

const emptyFieldMapping = (): FieldMapping => ({ from: '', to: '', direction: 'out' });
const emptyClassMapping = (): ClassMapping => ({ ciType: '', remoteClass: '' });

function initialState(existing: IntegrationDetail | null): FormState {
  if (existing === null) return { name: '', category: INTEGRATION_CATEGORIES[0], vendor: INTEGRATION_VENDORS[0], direction: DIRECTIONS[1], endpoint: '', credentialRef: '', events: [], fieldMappings: [], classMappings: [] };
  return { name: existing.name, category: existing.category, vendor: existing.vendor, direction: existing.direction, endpoint: existing.endpoint, credentialRef: existing.credentialRef, events: existing.subscribedEvents, fieldMappings: existing.fieldMappings, classMappings: existing.classMappings };
}

/** Form state → contract input; blank mapping rows are dropped. */
export function toIntegrationInput(state: FormState): IntegrationInput {
  return {
    category: state.category,
    vendor: state.vendor,
    name: state.name.trim(),
    endpoint: state.endpoint.trim(),
    credentialRef: state.credentialRef.trim(),
    direction: state.direction,
    subscribedEvents: state.events,
    fieldMappings: state.fieldMappings.filter((m) => m.from.trim() !== '' && m.to.trim() !== '').map((m) => ({ from: m.from.trim(), to: m.to.trim(), direction: m.direction })),
    classMappings: state.classMappings.filter((m) => m.ciType.trim() !== '' && m.remoteClass.trim() !== '').map((m) => ({ ciType: m.ciType.trim(), remoteClass: m.remoteClass.trim() })),
  };
}

function IntegrationForm({ existing, onDone }: FormProps): ReactNode {
  const t = useT();
  const id = useId();
  const [state, setState] = useState<FormState>(() => initialState(existing));
  const mutation = useMutation({
    mutationFn: (input: IntegrationInput) => upsertIntegration(existing?.id ?? null, input),
    onSuccess: (saved) => {
      onDone(saved);
    },
  });
  const vendors = useMemo(() => [...INTEGRATION_VENDORS].sort(), []);
  const valid = state.name.trim() !== '' && state.endpoint.trim() !== '' && state.credentialRef.trim() !== '';
  const update = (patch: Partial<FormState>): void => {
    setState((s) => ({ ...s, ...patch }));
  };
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!valid) return;
    mutation.mutate(toIntegrationInput(state));
  };

  return (
    <Card padding="24" className="flex flex-col gap-om-16">
      <form onSubmit={onSubmit} aria-label={existing === null ? t('integrations.new') : t('integrations.edit')} className="flex flex-col gap-om-12">
        <SectionTitle as="h2" size="sm" action={<Icon name="integrations" className="size-5 text-om-violet" />}>
          {existing === null ? t('integrations.new') : t('integrations.editing', { name: existing.name })}
        </SectionTitle>
        <Field id={id + '-name'} label={t('integrations.table.name')}>
          <TextInput
            id={id + '-name'}
            value={state.name}
            required
            onChange={(event) => {
              update({ name: event.target.value });
            }}
          />
        </Field>
        <div className="grid grid-cols-1 gap-om-12 md:grid-cols-3">
          <Field id={id + '-category'} label={t('integrations.form.category')}>
            <Select
              id={id + '-category'}
              value={state.category}
              onChange={(event) => {
                update({ category: event.target.value });
              }}
            >
              {INTEGRATION_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(categoryKey(c))}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={id + '-vendor'} label={t('integrations.table.vendor')}>
            <Select
              id={id + '-vendor'}
              value={state.vendor}
              onChange={(event) => {
                update({ vendor: event.target.value });
              }}
            >
              {vendors.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={id + '-direction'} label={t('integrations.table.direction')}>
            <Select
              id={id + '-direction'}
              value={state.direction}
              onChange={(event) => {
                update({ direction: event.target.value });
              }}
            >
              {DIRECTIONS.map((d) => (
                <option key={d} value={d}>
                  {t(directionKey(d))}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field id={id + '-endpoint'} label={t('integrations.form.endpoint')} hint={t('integrations.form.endpointHint')}>
          <TextInput
            id={id + '-endpoint'}
            type="url"
            value={state.endpoint}
            required
            onChange={(event) => {
              update({ endpoint: event.target.value });
            }}
          />
        </Field>
        <Field id={id + '-credential'} label={t('integrations.form.credentialRef')} hint={t('integrations.form.credentialHint')}>
          <TextInput
            id={id + '-credential'}
            value={state.credentialRef}
            required
            onChange={(event) => {
              update({ credentialRef: event.target.value });
            }}
          />
        </Field>
        <Field id={id + '-events'} label={t('integrations.form.events')} hint={t('integrations.form.eventsHint')}>
          <Select
            id={id + '-events'}
            multiple
            value={state.events}
            onChange={(event) => {
              update({ events: Array.from(event.target.selectedOptions, (o) => o.value) });
            }}
            className="min-h-[7rem] font-om-mono"
          >
            {EVENT_TYPES.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex flex-col gap-om-6">
          <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('integrations.mappings.fields')}</span>
          {state.fieldMappings.map((m, i) => (
            <div key={i} className="grid grid-cols-3 gap-om-6">
              <TextInput
                aria-label={t('integrations.mappings.from')}
                value={m.from}
                onChange={(event) => {
                  update({ fieldMappings: state.fieldMappings.map((x, j) => (j === i ? { ...x, from: event.target.value } : x)) });
                }}
              />
              <TextInput
                aria-label={t('integrations.mappings.to')}
                value={m.to}
                onChange={(event) => {
                  update({ fieldMappings: state.fieldMappings.map((x, j) => (j === i ? { ...x, to: event.target.value } : x)) });
                }}
              />
              <Select
                aria-label={t('integrations.table.direction')}
                value={m.direction}
                onChange={(event) => {
                  update({ fieldMappings: state.fieldMappings.map((x, j) => (j === i ? { ...x, direction: event.target.value } : x)) });
                }}
              >
                <option value="out">{t('integrations.mappings.out')}</option>
                <option value="in">{t('integrations.mappings.in')}</option>
              </Select>
            </div>
          ))}
          <Button
            tone="quiet"
            className="self-start"
            onClick={() => {
              update({ fieldMappings: [...state.fieldMappings, emptyFieldMapping()] });
            }}
          >
            {t('integrations.mappings.addField')}
          </Button>
        </div>
        <div className="flex flex-col gap-om-6">
          <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('integrations.mappings.classes')}</span>
          {state.classMappings.map((m, i) => (
            <div key={i} className="grid grid-cols-2 gap-om-6">
              <TextInput
                aria-label={t('integrations.mappings.ciType')}
                value={m.ciType}
                onChange={(event) => {
                  update({ classMappings: state.classMappings.map((x, j) => (j === i ? { ...x, ciType: event.target.value } : x)) });
                }}
              />
              <TextInput
                aria-label={t('integrations.mappings.remoteClass')}
                value={m.remoteClass}
                onChange={(event) => {
                  update({ classMappings: state.classMappings.map((x, j) => (j === i ? { ...x, remoteClass: event.target.value } : x)) });
                }}
              />
            </div>
          ))}
          <Button
            tone="quiet"
            className="self-start"
            onClick={() => {
              update({ classMappings: [...state.classMappings, emptyClassMapping()] });
            }}
          >
            {t('integrations.mappings.addClass')}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-om-10">
          <Button type="submit" disabled={!valid || mutation.isPending}>
            {mutation.isPending ? t('integrations.saving') : t('integrations.save')}
          </Button>
          <Button
            tone="quiet"
            onClick={() => {
              onDone(null);
            }}
          >
            {t('integrations.cancel')}
          </Button>
          {mutation.isError ? (
            <p role="alert" className="text-om-xs text-om-rose">
              {t('integrations.saveFailed')}
            </p>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
