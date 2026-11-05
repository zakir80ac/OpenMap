'use client';
// REQ-UI-012 REQ-BSM-006 — the SLA catalogue: every service level agreement with its target, window, response and
// resolution targets by severity and the services held to it; operators create, edit and delete them (ADR-024).
import { SLA, type SlaWindow } from '@openmap/constants';
import { Card, SectionTitle, Tag } from '@openmap/ui';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Button, Field, Select, TextArea, TextInput } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import type { IncidentSeverity, Sla, SlaInput } from '@/lib/queries';
import { useFormatters, useT, type Translate } from '@/providers';
import type { DeleteSla, SaveSla } from './types';

/** Severities a person sets targets for in the form; the rest take the platform defaults. */
const FORM_SEVERITIES: readonly IncidentSeverity[] = ['critical', 'high', 'medium'];

export const windowKey = {
  calendar_month: 'services.sla.window.calendar_month',
  calendar_quarter: 'services.sla.window.calendar_quarter',
  calendar_year: 'services.sla.window.calendar_year',
  rolling_30d: 'services.sla.window.rolling_30d',
} as const satisfies Record<SlaWindow, string>;

export const severityKey = {
  critical: 'services.sla.severity.critical',
  high: 'services.sla.severity.high',
  medium: 'services.sla.severity.medium',
  low: 'services.sla.severity.low',
  informational: 'services.sla.severity.informational',
} as const satisfies Record<IncidentSeverity, string>;

interface Draft {
  name: string;
  description: string;
  target: string;
  window: SlaWindow;
  burnRate: string;
  targets: Record<IncidentSeverity, { respond: string; resolve: string }>;
}

function emptyDraft(): Draft {
  const targets = {} as Draft['targets'];
  for (const severity of ['critical', 'high', 'medium', 'low', 'informational'] as const) {
    targets[severity] = {
      respond: String(SLA.defaultTargets[severity].respondMinutes),
      resolve: String(SLA.defaultTargets[severity].resolveMinutes),
    };
  }
  return {
    name: '',
    description: '',
    target: '',
    window: 'calendar_month',
    burnRate: String(SLA.defaultBurnRateAlert),
    targets,
  };
}

function draftOf(sla: Sla): Draft {
  const draft = emptyDraft();
  draft.name = sla.name;
  draft.description = sla.description;
  draft.target = String(sla.availabilityTargetPercent);
  draft.window = sla.window;
  draft.burnRate = String(sla.burnRateAlert);
  for (const target of sla.responseTargets)
    draft.targets[target.severity] = {
      respond: String(target.respondMinutes),
      resolve: String(target.resolveMinutes),
    };
  return draft;
}

/** The mutation input of a draft, or null while a required field is missing or not a number. */
export function toSlaInput(draft: Draft): SlaInput | null {
  const target = Number(draft.target);
  const burnRate = Number(draft.burnRate);
  if (draft.name.trim() === '' || !Number.isFinite(target) || draft.target.trim() === '') return null;
  const responseTargets: SlaInput['responseTargets'] = [];
  for (const severity of FORM_SEVERITIES) {
    const respond = Number(draft.targets[severity].respond);
    const resolve = Number(draft.targets[severity].resolve);
    if (!Number.isFinite(respond) || !Number.isFinite(resolve) || respond <= 0 || resolve <= 0) return null;
    responseTargets.push({
      severity,
      respondMinutes: Math.round(respond),
      resolveMinutes: Math.round(resolve),
    });
  }
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    availabilityTargetPercent: target,
    window: draft.window,
    responseTargets,
    ...(Number.isFinite(burnRate) && burnRate > 0 ? { burnRateAlert: burnRate } : {}),
  };
}

export function slaSummary(
  sla: Pick<Sla, 'availabilityTargetPercent' | 'window'>,
  t: Translate,
  percent: (v: number) => string,
): string {
  return t('services.sla.summary', {
    target: percent(sla.availabilityTargetPercent),
    window: t(windowKey[sla.window]),
  });
}

export interface SlaPanelProps {
  slas: ReadonlyArray<Sla>;
  status: 'pending' | 'error' | 'success';
  onRetry: () => void;
  canEdit: boolean;
  onSave: SaveSla;
  onDelete: DeleteSla;
}

export function SlaPanel({ slas, status, onRetry, canEdit, onSave, onDelete }: SlaPanelProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const formId = useId();
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  /** 'save' while the form submits, an SLA id while that SLA is being deleted. */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  const input = toSlaInput(draft);

  const start = (sla: Sla | null): void => {
    setEditing(sla?.id ?? null);
    setDraft(sla === null ? emptyDraft() : draftOf(sla));
    setOpen(true);
    setSaved(false);
    setError(false);
  };
  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (input === null) return;
    setBusy('save');
    setError(false);
    try {
      await onSave(editing, input);
      setSaved(true);
      setOpen(false);
      setDraft(emptyDraft());
      setEditing(null);
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (id: string): Promise<void> => {
    setBusy(id);
    setError(false);
    try {
      await onDelete(id);
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  };
  const targetField = (severity: IncidentSeverity, kind: 'respond' | 'resolve'): ReactNode => {
    const id = formId + '-' + severity + '-' + kind;
    return (
      <Field
        key={id}
        id={id}
        label={
          t(severityKey[severity]) +
          ' · ' +
          t(kind === 'respond' ? 'services.sla.respond' : 'services.sla.resolve')
        }
      >
        <TextInput
          id={id}
          inputMode="numeric"
          value={draft.targets[severity][kind]}
          onChange={(e) => {
            const value = e.target.value;
            setDraft((d) => ({
              ...d,
              targets: { ...d.targets, [severity]: { ...d.targets[severity], [kind]: value } },
            }));
          }}
        />
      </Field>
    );
  };

  return (
    <Card as="section" className="flex flex-col gap-om-12" aria-labelledby="sla-title">
      <SectionTitle
        as="h2"
        size="sm"
        description={t('services.sla.subtitle')}
        action={
          canEdit ? (
            <Button
              onClick={() => {
                start(null);
              }}
            >
              {t('services.sla.new')}
            </Button>
          ) : undefined
        }
      >
        <span id="sla-title">{t('services.sla.title')}</span>
      </SectionTitle>
      {status === 'pending' ? (
        <QueryState status="pending" />
      ) : status === 'error' ? (
        <QueryState status="error" onRetry={onRetry} />
      ) : slas.length === 0 ? (
        <p className="text-om-sm text-om-secondary">{t('services.sla.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-om-8" data-testid="sla-list">
          {slas.map((sla) => (
            <li
              key={sla.id}
              className="flex flex-col gap-om-4 rounded-om-panel border border-om-border-glass bg-om-surface2/60 p-om-10"
              data-sla-name={sla.name}
            >
              <div className="flex flex-wrap items-center gap-om-8">
                <span className="font-om-display text-om-sm font-bold text-om-primary">{sla.name}</span>
                <Tag>{slaSummary(sla, t, format.percent)}</Tag>
                <Tag>{t('services.sla.servicesCount', { count: format.integer(sla.services.length) })}</Tag>
                {canEdit ? (
                  <span className="ms-auto flex gap-om-6">
                    <Button
                      tone="quiet"
                      onClick={() => {
                        start(sla);
                      }}
                    >
                      {t('common.edit')}
                    </Button>
                    <Button
                      tone="danger"
                      disabled={busy === sla.id}
                      onClick={() => {
                        void remove(sla.id);
                      }}
                    >
                      {busy === sla.id ? t('services.sla.deleting') : t('services.sla.delete')}
                    </Button>
                  </span>
                ) : null}
              </div>
              {sla.description !== '' ? (
                <p className="text-om-xs text-om-secondary">{sla.description}</p>
              ) : null}
              <ul className="flex flex-wrap gap-om-6 text-om-2xs text-om-muted">
                {sla.responseTargets
                  .filter((target) => FORM_SEVERITIES.includes(target.severity))
                  .map((target) => (
                    <li key={target.severity}>
                      {t('services.sla.targets', {
                        severity: t(severityKey[target.severity]),
                        respond: format.integer(target.respondMinutes),
                        resolve: format.integer(target.resolveMinutes),
                      })}
                    </li>
                  ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {saved ? (
        <p role="status" className="text-om-xs text-om-emerald">
          {t('services.sla.saved')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-om-xs text-om-rose">
          {t('services.sla.error')}
        </p>
      ) : null}
      {open && canEdit ? (
        <form
          className="grid grid-cols-1 gap-om-10 rounded-om-panel border border-om-border-strong bg-om-surface3 p-om-12 md:grid-cols-2"
          aria-label={t(editing === null ? 'services.sla.create' : 'services.sla.save')}
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <Field id={formId + '-name'} label={t('services.sla.name')}>
            <TextInput
              id={formId + '-name'}
              value={draft.name}
              required
              onChange={(e) => {
                const value = e.target.value;
                setDraft((d) => ({ ...d, name: value }));
              }}
            />
          </Field>
          <Field id={formId + '-target'} label={t('services.sla.target')}>
            <TextInput
              id={formId + '-target'}
              inputMode="decimal"
              value={draft.target}
              required
              onChange={(e) => {
                const value = e.target.value;
                setDraft((d) => ({ ...d, target: value }));
              }}
            />
          </Field>
          <Field id={formId + '-window'} label={t('services.sla.window')}>
            <Select
              id={formId + '-window'}
              value={draft.window}
              onChange={(e) => {
                const value = e.target.value as SlaWindow;
                setDraft((d) => ({ ...d, window: value }));
              }}
            >
              {SLA.windows.map((w) => (
                <option key={w} value={w}>
                  {t(windowKey[w])}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={formId + '-burn'} label={t('services.sla.burnRate')}>
            <TextInput
              id={formId + '-burn'}
              inputMode="decimal"
              value={draft.burnRate}
              onChange={(e) => {
                const value = e.target.value;
                setDraft((d) => ({ ...d, burnRate: value }));
              }}
            />
          </Field>
          <Field id={formId + '-description'} label={t('services.sla.description')} className="md:col-span-2">
            <TextArea
              id={formId + '-description'}
              rows={SLA.rcaRows}
              value={draft.description}
              onChange={(e) => {
                const value = e.target.value;
                setDraft((d) => ({ ...d, description: value }));
              }}
            />
          </Field>
          {FORM_SEVERITIES.map((severity) => [
            targetField(severity, 'respond'),
            targetField(severity, 'resolve'),
          ])}
          <div className="flex items-center gap-om-8 md:col-span-2">
            <Button type="submit" disabled={input === null || busy === 'save'}>
              {busy === 'save'
                ? t('services.sla.saving')
                : editing === null
                  ? t('services.sla.create')
                  : t('services.sla.save')}
            </Button>
            <Button
              tone="quiet"
              onClick={() => {
                setOpen(false);
              }}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}
