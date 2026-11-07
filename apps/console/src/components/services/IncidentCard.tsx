'use client';
// REQ-UI-012 REQ-BSM-006 — one incident: severity, state, source and SLA, the response and resolution deadlines with
// their breach marks, the assignee, the operator actions (acknowledge, assign, resolve with a note, close), the root
// cause analysis form and the audited timeline (ADR-024); REQ-BSM-005: the incident's runbook with its steps (ADR-048).
import Link from 'next/link';
import { SLA, TIME } from '@openmap/constants';
import type { Locale } from '@openmap/i18n';
import { Dot, Tag, type UiState } from '@openmap/ui';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Button, Field, TextArea, TextInput } from '@/components/common/controls';
import { Icon } from '@/components/icons';
import { localizedHref } from '@/lib/locale-path';
import type { CiRef, Incident, IncidentSeverity, IncidentState, Rca, RcaInput } from '@/lib/queries';
import { useFormatters, useT } from '@/providers';
import { IncidentRunbook } from './IncidentRunbook';
import { severityKey } from './SlaPanel';
import type { IncidentAction, IncidentActions, Work } from './types';

export const severityState = {
  critical: 'down',
  high: 'down',
  medium: 'degraded',
  low: 'unknown',
  informational: 'unknown',
} as const satisfies Record<IncidentSeverity, UiState>;

export const incidentStateTone = {
  open: 'down',
  acknowledged: 'degraded',
  mitigated: 'at_risk',
  resolved: 'healthy',
  closed: 'unknown',
} as const satisfies Record<IncidentState, UiState>;

export const incidentStateKey = {
  open: 'services.incidents.state.open',
  acknowledged: 'services.incidents.state.acknowledged',
  mitigated: 'services.incidents.state.mitigated',
  resolved: 'services.incidents.state.resolved',
  closed: 'services.incidents.state.closed',
} as const satisfies Record<IncidentState, string>;

export type { IncidentAction, IncidentActions } from './types';

export interface IncidentCardProps {
  locale: Locale;
  incident: Incident;
  canOperate: boolean;
  actions: IncidentActions;
}

interface RcaDraft {
  summary: string;
  rootCauseCiId: string;
  factors: string;
  actions: Array<{ description: string; owner: string; dueAt: string; done: boolean }>;
  owner: string;
  dueAt: string;
  completedAt: string;
}

const LINE_BREAK = '\n';

function dateInput(iso: string | null): string {
  return iso === null ? '' : iso.slice(0, TIME.isoDateLength);
}

function isoOfDate(value: string): string | null {
  return value === '' ? null : new Date(value).toISOString();
}

function rcaDraftOf(rca: Rca | null, fallbackRootCause: CiRef | null): RcaDraft {
  return {
    summary: rca?.summary ?? '',
    rootCauseCiId: rca?.rootCauseCi?.id ?? fallbackRootCause?.id ?? '',
    factors: (rca?.contributingFactors ?? []).join(LINE_BREAK),
    actions: (rca?.correctiveActions ?? []).map((a) => ({
      description: a.description,
      owner: a.owner ?? '',
      dueAt: dateInput(a.dueAt),
      done: a.done,
    })),
    owner: rca?.owner ?? '',
    dueAt: dateInput(rca?.dueAt ?? null),
    completedAt: dateInput(rca?.completedAt ?? null),
  };
}

/** The mutation input of a draft; null until the summary is filled. Blank action rows are dropped. */
export function toRcaInput(draft: RcaDraft): RcaInput | null {
  if (draft.summary.trim() === '') return null;
  return {
    summary: draft.summary.trim(),
    rootCauseCiId: draft.rootCauseCiId === '' ? null : draft.rootCauseCiId,
    contributingFactors: draft.factors
      .split(LINE_BREAK)
      .map((f) => f.trim())
      .filter((f) => f !== ''),
    correctiveActions: draft.actions
      .filter((a) => a.description.trim() !== '')
      .map((a) => ({
        description: a.description.trim(),
        owner: a.owner.trim() === '' ? null : a.owner.trim(),
        dueAt: isoOfDate(a.dueAt),
        done: a.done,
      })),
    owner: draft.owner.trim() === '' ? null : draft.owner.trim(),
    dueAt: isoOfDate(draft.dueAt),
    completedAt: isoOfDate(draft.completedAt),
  };
}

function ciHref(locale: Locale, id: string): string {
  return localizedHref(locale, '/cmdb/' + encodeURIComponent(id));
}

export function IncidentCard({ locale, incident, canOperate, actions }: IncidentCardProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const formId = useId();
  const [busy, setBusy] = useState<IncidentAction | null>(null);
  const [failed, setFailed] = useState<IncidentAction | null>(null);
  const [assignee, setAssignee] = useState('');
  const [note, setNote] = useState('');
  const [showRca, setShowRca] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const [showRunbook, setShowRunbook] = useState(incident.runbook !== null && incident.state !== 'resolved' && incident.state !== 'closed');
  const [rca, setRca] = useState<RcaDraft>(() => rcaDraftOf(incident.rca, incident.rootCause));
  const active = incident.state !== 'resolved' && incident.state !== 'closed';
  const rcaInput = toRcaInput(rca);

  const run = async (action: IncidentAction, work: Work): Promise<void> => {
    setBusy(action);
    setFailed(null);
    try {
      await work();
      if (action === 'assign') setAssignee('');
      if (action === 'resolve') setNote('');
    } catch {
      setFailed(action);
    } finally {
      setBusy(null);
    }
  };
  const submitRca = (event: SyntheticEvent): void => {
    event.preventDefault();
    if (rcaInput === null) return;
    void run('rca', () => actions.saveRca(incident.id, rcaInput));
  };
  const setAction = (index: number, patch: Partial<RcaDraft['actions'][number]>): void => {
    setRca((d) => ({ ...d, actions: d.actions.map((a, i) => (i === index ? { ...a, ...patch } : a)) }));
  };

  return (
    <li
      className="flex flex-col gap-om-8 rounded-om-panel border border-om-border-glass bg-om-surface2/60 p-om-10"
      data-incident-id={incident.id}
      data-state={incident.state}
    >
      <div className="flex flex-wrap items-center gap-om-6">
        <Dot state={incidentStateTone[incident.state]} pulse={incident.state === 'open'} />
        <Link
          href={ciHref(locale, incident.service.id)}
          className="min-w-0 text-om-sm font-medium text-om-primary hover:text-om-cyan"
        >
          {incident.title}
        </Link>
        <Tag variant="state" state={severityState[incident.severity]}>
          {t(severityKey[incident.severity])}
        </Tag>
        <Tag variant="state" state={incidentStateTone[incident.state]}>
          {t(incidentStateKey[incident.state])}
        </Tag>
        <Tag>{t('services.incidents.alerts', { count: format.integer(incident.alerts) })}</Tag>
      </div>
      <p className="text-om-2xs text-om-muted">
        {t('services.incidents.opened', { when: format.dateTime(incident.openedAt) })}
        {incident.resolvedAt !== null
          ? ' · ' + t('services.incidents.resolved', { when: format.dateTime(incident.resolvedAt) })
          : ''}
        {' · ' + t('services.incidents.source', { source: incident.source })}
        {incident.sla !== null ? ' · ' + t('services.incidents.sla', { name: incident.sla.name }) : ''}
      </p>
      <div className="flex flex-wrap items-center gap-om-6 text-om-2xs">
        <span className={incident.assignee === null ? 'text-om-muted' : 'text-om-secondary'}>
          {incident.assignee === null
            ? t('services.incidents.unassigned')
            : t('services.incidents.assignee', { name: incident.assignee })}
        </span>
        {active && incident.respondBy !== null && incident.acknowledgedAt === null ? (
          <span className="text-om-secondary">
            {t('services.incidents.respondBy', { when: format.dateTime(incident.respondBy) })}
          </span>
        ) : null}
        {active && incident.resolveBy !== null ? (
          <span className="text-om-secondary">
            {t('services.incidents.resolveBy', { when: format.dateTime(incident.resolveBy) })}
          </span>
        ) : null}
        {incident.responseBreachedAt !== null ? (
          <Tag variant="state" state="down">
            {t('services.incidents.responseMissed')}
          </Tag>
        ) : null}
        {incident.resolutionBreachedAt !== null ? (
          <Tag variant="state" state="down">
            {t('services.incidents.resolutionMissed')}
          </Tag>
        ) : null}
      </div>
      {incident.rootCause !== null ? (
        <Link
          href={ciHref(locale, incident.rootCause.id)}
          className="text-om-xs text-om-rose hover:underline"
        >
          {t('services.incidents.rootCause', { name: incident.rootCause.displayName })}
        </Link>
      ) : null}
      {incident.resolutionNote !== null ? (
        <p className="text-om-xs text-om-secondary">
          {t('services.incidents.note', { note: incident.resolutionNote })}
        </p>
      ) : null}
      {incident.links.length > 0 ? (
        <ul className="flex flex-wrap gap-om-4">
          {incident.links.map((link) => (
            <li key={link.integration.id + link.remoteId}>
              <Tag>
                {t('services.incidents.link', {
                  vendor: link.integration.vendor,
                  remoteId: link.remoteId,
                  state: link.remoteState,
                })}
              </Tag>
            </li>
          ))}
        </ul>
      ) : null}
      {canOperate && active ? (
        <div className="flex flex-wrap items-end gap-om-6">
          {incident.state === 'open' ? (
            <Button
              disabled={busy !== null}
              onClick={() => {
                void run('acknowledge', () => actions.acknowledge(incident.id));
              }}
            >
              <span className="flex items-center gap-om-4">
                <Icon name="check" className="size-3.5" />
                {busy === 'acknowledge'
                  ? t('services.incidents.acknowledging')
                  : t('services.incidents.acknowledge')}
              </span>
            </Button>
          ) : null}
          <Field id={formId + '-assignee'} label={t('services.incidents.assignTo')}>
            <span className="flex gap-om-4">
              <TextInput
                id={formId + '-assignee'}
                value={assignee}
                onChange={(e) => {
                  setAssignee(e.target.value);
                }}
              />
              <Button
                tone="quiet"
                disabled={busy !== null || assignee.trim() === ''}
                onClick={() => {
                  void run('assign', () => actions.assign(incident.id, assignee.trim()));
                }}
              >
                {busy === 'assign' ? t('services.incidents.assigning') : t('services.incidents.assign')}
              </Button>
            </span>
          </Field>
          <Field id={formId + '-note'} label={t('services.incidents.resolveNote')}>
            <span className="flex gap-om-4">
              <TextInput
                id={formId + '-note'}
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                }}
              />
              <Button
                tone="quiet"
                disabled={busy !== null || note.trim() === ''}
                onClick={() => {
                  void run('resolve', () => actions.resolve(incident.id, note.trim()));
                }}
              >
                {busy === 'resolve' ? t('services.incidents.resolving') : t('services.incidents.resolve')}
              </Button>
            </span>
          </Field>
        </div>
      ) : null}
      {canOperate && incident.state === 'resolved' ? (
        <div>
          <Button
            tone="quiet"
            disabled={busy !== null}
            onClick={() => {
              void run('close', () => actions.close(incident.id));
            }}
          >
            {busy === 'close' ? t('services.incidents.closing') : t('services.incidents.close')}
          </Button>
        </div>
      ) : null}
      {failed !== null && failed !== 'rca' ? (
        <p role="alert" className="text-om-xs text-om-rose">
          {t('services.incidents.actionError')}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-om-6">
        <Button
          tone="quiet"
          aria-expanded={showRca}
          aria-controls={formId + '-rca'}
          onClick={() => {
            setShowRca((v) => !v);
          }}
        >
          {t('services.rca.open')}
        </Button>
        <Button
          tone="quiet"
          aria-expanded={showRunbook}
          aria-controls={formId + '-runbook'}
          onClick={() => {
            setShowRunbook((v) => !v);
          }}
        >
          {t('services.runbook.title')}
        </Button>
        <Button
          tone="quiet"
          aria-expanded={showTimeline}
          aria-controls={formId + '-timeline'}
          onClick={() => {
            setShowTimeline((v) => !v);
          }}
        >
          {t('services.timeline.title')}
        </Button>
      </div>
      {showRca ? (
        <section
          id={formId + '-rca'}
          aria-label={t('services.rca.title')}
          className="flex flex-col gap-om-8 rounded-om-panel border border-om-border-strong bg-om-surface3 p-om-10"
        >
          {incident.rca !== null ? (
            <p className="text-om-2xs text-om-muted">
              {t('services.rca.saved', {
                by: incident.rca.updatedBy,
                when: format.dateTime(incident.rca.updatedAt),
              })}
            </p>
          ) : (
            <p className="text-om-2xs text-om-muted">{t('services.rca.empty')}</p>
          )}
          {canOperate ? (
            <form className="grid grid-cols-1 gap-om-8 md:grid-cols-2" onSubmit={submitRca}>
              <Field id={formId + '-summary'} label={t('services.rca.summary')} className="md:col-span-2">
                <TextArea
                  id={formId + '-summary'}
                  rows={SLA.rcaRows}
                  value={rca.summary}
                  required
                  onChange={(e) => {
                    const value = e.target.value;
                    setRca((d) => ({ ...d, summary: value }));
                  }}
                />
              </Field>
              <Field
                id={formId + '-root'}
                label={t('services.rca.rootCause')}
                hint={incident.rootCause !== null ? t('services.rca.useRootCause') : undefined}
              >
                <TextInput
                  id={formId + '-root'}
                  value={rca.rootCauseCiId}
                  onChange={(e) => {
                    const value = e.target.value;
                    setRca((d) => ({ ...d, rootCauseCiId: value }));
                  }}
                />
              </Field>
              <Field id={formId + '-owner'} label={t('services.rca.owner')}>
                <TextInput
                  id={formId + '-owner'}
                  value={rca.owner}
                  onChange={(e) => {
                    const value = e.target.value;
                    setRca((d) => ({ ...d, owner: value }));
                  }}
                />
              </Field>
              <Field id={formId + '-factors'} label={t('services.rca.factors')} className="md:col-span-2">
                <TextArea
                  id={formId + '-factors'}
                  rows={SLA.rcaRows}
                  value={rca.factors}
                  onChange={(e) => {
                    const value = e.target.value;
                    setRca((d) => ({ ...d, factors: value }));
                  }}
                />
              </Field>
              <fieldset className="flex flex-col gap-om-6 md:col-span-2">
                <legend className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
                  {t('services.rca.actions')}
                </legend>
                {rca.actions.map((action, index) => (
                  <div
                    key={index}
                    className="grid grid-cols-1 gap-om-6 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)_minmax(0,2fr)_auto]"
                  >
                    <Field
                      id={formId + '-action-' + String(index)}
                      label={t('services.rca.action.description')}
                    >
                      <TextInput
                        id={formId + '-action-' + String(index)}
                        value={action.description}
                        onChange={(e) => {
                          setAction(index, { description: e.target.value });
                        }}
                      />
                    </Field>
                    <Field
                      id={formId + '-action-owner-' + String(index)}
                      label={t('services.rca.action.owner')}
                    >
                      <TextInput
                        id={formId + '-action-owner-' + String(index)}
                        value={action.owner}
                        onChange={(e) => {
                          setAction(index, { owner: e.target.value });
                        }}
                      />
                    </Field>
                    <Field id={formId + '-action-due-' + String(index)} label={t('services.rca.action.due')}>
                      <TextInput
                        id={formId + '-action-due-' + String(index)}
                        type="date"
                        value={action.dueAt}
                        onChange={(e) => {
                          setAction(index, { dueAt: e.target.value });
                        }}
                      />
                    </Field>
                    <label className="flex items-center gap-om-4 self-end pb-om-6 text-om-xs text-om-secondary">
                      <input
                        type="checkbox"
                        checked={action.done}
                        onChange={(e) => {
                          setAction(index, { done: e.target.checked });
                        }}
                      />
                      {t('services.rca.action.done')}
                    </label>
                  </div>
                ))}
                <div>
                  <Button
                    tone="quiet"
                    onClick={() => {
                      setRca((d) => ({
                        ...d,
                        actions: [...d.actions, { description: '', owner: '', dueAt: '', done: false }],
                      }));
                    }}
                  >
                    {t('services.rca.addAction')}
                  </Button>
                </div>
              </fieldset>
              <Field id={formId + '-due'} label={t('services.rca.due')}>
                <TextInput
                  id={formId + '-due'}
                  type="date"
                  value={rca.dueAt}
                  onChange={(e) => {
                    const value = e.target.value;
                    setRca((d) => ({ ...d, dueAt: value }));
                  }}
                />
              </Field>
              <Field id={formId + '-completed'} label={t('services.rca.completed')}>
                <TextInput
                  id={formId + '-completed'}
                  type="date"
                  value={rca.completedAt}
                  onChange={(e) => {
                    const value = e.target.value;
                    setRca((d) => ({ ...d, completedAt: value }));
                  }}
                />
              </Field>
              <div className="flex items-center gap-om-8 md:col-span-2">
                <Button type="submit" disabled={rcaInput === null || busy === 'rca'}>
                  {busy === 'rca' ? t('services.rca.saving') : t('services.rca.save')}
                </Button>
                {failed === 'rca' ? (
                  <span role="alert" className="text-om-xs text-om-rose">
                    {t('services.rca.error')}
                  </span>
                ) : null}
              </div>
            </form>
          ) : incident.rca !== null ? (
            <div className="flex flex-col gap-om-4 text-om-xs text-om-secondary">
              <p>{incident.rca.summary}</p>
              {incident.rca.rootCauseCi !== null ? (
                <Link
                  href={ciHref(locale, incident.rca.rootCauseCi.id)}
                  className="text-om-rose hover:underline"
                >
                  {incident.rca.rootCauseCi.displayName}
                </Link>
              ) : null}
              {incident.rca.contributingFactors.length > 0 ? (
                <ul className="list-disc ps-om-16">
                  {incident.rca.contributingFactors.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
      {showRunbook ? (
        <section
          id={formId + '-runbook'}
          aria-label={t('services.runbook.title')}
          className="rounded-om-panel border border-om-border-strong bg-om-surface3 p-om-10"
        >
          <IncidentRunbook incident={incident} canOperate={canOperate} />
        </section>
      ) : null}
      {showTimeline ? (
        <section
          id={formId + '-timeline'}
          aria-label={t('services.timeline.title')}
          className="rounded-om-panel border border-om-border-strong bg-om-surface3 p-om-10"
        >
          {incident.timeline.length === 0 ? (
            <p className="text-om-2xs text-om-muted">{t('services.timeline.empty')}</p>
          ) : (
            <ol className="flex flex-col gap-om-4 text-om-2xs">
              {incident.timeline.map((event, index) => (
                <li key={event.at + event.kind + String(index)} className="flex flex-wrap gap-om-6">
                  <span className="font-om-mono text-om-muted">{format.dateTime(event.at)}</span>
                  <span className="text-om-secondary">{event.actor}</span>
                  <span className="font-om-mono text-om-primary">{event.kind}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}
    </li>
  );
}
