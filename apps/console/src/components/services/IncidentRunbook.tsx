'use client';
// REQ-BSM-005 REQ-UI-012 (ADR-048) — the runbook of one incident. With none attached, an operator picks one from the
// catalogue; the runbook of the saved scenario of the incident's root cause is preselected. With one attached:
// - the recovery estimate and the minutes still to go;
// - the steps in order, each with its latest outcome and its action: a manual step is marked done, an automated step
//   triggers its SOAR playbook or automation job;
// - the history of every step run.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Tag, type UiState } from '@openmap/ui';
import { useId, useState, type ReactNode } from 'react';
import { Button, Field, Select } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import {
  runbooksQuery,
  runRunbookStep,
  setIncidentRunbook,
  type Incident,
  type RunbookStepRun,
} from '@/lib/queries';
import { useFormatters, useT } from '@/providers';

export interface IncidentRunbookProps {
  incident: Incident;
  canOperate: boolean;
}

const outcomeTone = { done: 'healthy', triggered: 'healthy', failed: 'down' } as const satisfies Record<
  RunbookStepRun['outcome'],
  UiState
>;
const outcomeKey = {
  done: 'services.runbook.outcome.done',
  triggered: 'services.runbook.outcome.triggered',
  failed: 'services.runbook.outcome.failed',
} as const satisfies Record<RunbookStepRun['outcome'], string>;

export function IncidentRunbook({ incident, canOperate }: IncidentRunbookProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState(incident.suggestedRunbook?.id ?? '');
  const runbooks = useQuery({ ...runbooksQuery(), enabled: incident.runbook === null });
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['incidents'] });
    void queryClient.invalidateQueries({ queryKey: ['service'] });
  };
  const attach = useMutation({
    mutationFn: (runbookId: string | null) => setIncidentRunbook(incident.id, runbookId),
    onSuccess: refresh,
  });
  const run = useMutation({
    mutationFn: (order: number) => runRunbookStep(incident.id, order),
    onSuccess: refresh,
  });
  const open = incident.state !== 'closed';
  const minutes = (value: number | null): string =>
    value === null
      ? t('services.runbook.noEstimate')
      : t('services.runbook.minutes', { minutes: format.integer(value) });

  if (incident.runbook === null) {
    return (
      <div className="flex flex-col gap-om-8">
        <p className="text-om-2xs text-om-muted">{t('services.runbook.none')}</p>
        {incident.suggestedRunbook !== null ? (
          <p className="text-om-2xs text-om-secondary">
            {t('services.runbook.suggested', {
              code: incident.suggestedRunbook.code,
              title: incident.suggestedRunbook.title,
            })}
          </p>
        ) : null}
        {canOperate ? (
          runbooks.isPending ? (
            <QueryState status="pending" />
          ) : runbooks.isError ? (
            <QueryState
              status="error"
              onRetry={() => {
                void runbooks.refetch();
              }}
            />
          ) : runbooks.data.length === 0 ? (
            <p className="text-om-2xs text-om-muted">{t('services.runbook.catalogueEmpty')}</p>
          ) : (
            <div className="flex flex-wrap items-end gap-om-6">
              <Field id={id + '-runbook'} label={t('services.runbook.pick')} className="min-w-0 flex-1">
                <Select
                  id={id + '-runbook'}
                  value={choice}
                  onChange={(e) => {
                    setChoice(e.target.value);
                  }}
                >
                  <option value="">{t('services.runbook.pickNone')}</option>
                  {runbooks.data.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.code + ' · ' + r.title}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                disabled={choice === '' || attach.isPending}
                onClick={() => {
                  attach.mutate(choice);
                }}
              >
                {t('services.runbook.attach')}
              </Button>
            </div>
          )
        ) : null}
        {attach.isError ? (
          <p role="alert" className="text-om-xs text-om-rose">
            {t('services.runbook.error')}
          </p>
        ) : null}
      </div>
    );
  }

  const runbook = incident.runbook;
  const latest = new Map<number, RunbookStepRun>();
  for (const r of incident.runbookRuns) latest.set(r.order, r);
  return (
    <div className="flex flex-col gap-om-8">
      <div className="flex flex-wrap items-center justify-between gap-om-6">
        <span className="text-om-sm font-medium text-om-primary">{runbook.code + ' · ' + runbook.title}</span>
        <span className="flex flex-wrap gap-om-4">
          <Tag>{t('services.runbook.estimate', { value: minutes(incident.recoveryEstimateMinutes) })}</Tag>
          <Tag>{t('services.runbook.remaining', { value: minutes(incident.recoveryRemainingMinutes) })}</Tag>
        </span>
      </div>
      <ol className="flex flex-col gap-om-6" aria-label={t('services.runbook.steps')}>
        {runbook.steps.map((step) => {
          const last = latest.get(step.order);
          return (
            <li
              key={step.order}
              className="flex flex-wrap items-center gap-om-8 rounded-om-panel border border-om-border-glass bg-om-surface2/60 px-om-10 py-om-6 text-om-xs"
            >
              <span className="font-om-mono text-om-muted">{String(step.order)}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-om-primary">{step.instruction}</span>
                <span className="block text-om-2xs text-om-muted">
                  {minutes(step.estimatedMinutes)}
                  {step.automation !== null
                    ? ' · ' +
                      t('services.runbook.automation', {
                        integration:
                          step.automation.integration?.name ?? t('services.runbook.missingIntegration'),
                        action: step.automation.action,
                      })
                    : ''}
                </span>
              </span>
              {last !== undefined ? (
                <Tag variant="state" state={outcomeTone[last.outcome]}>
                  {t(outcomeKey[last.outcome])}
                </Tag>
              ) : null}
              {canOperate && open ? (
                <Button
                  tone="quiet"
                  disabled={run.isPending}
                  onClick={() => {
                    run.mutate(step.order);
                  }}
                >
                  {step.automation !== null ? t('services.runbook.trigger') : t('services.runbook.markDone')}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ol>
      {run.isError || attach.isError ? (
        <p role="alert" className="text-om-xs text-om-rose">
          {t('services.runbook.error')}
        </p>
      ) : null}
      {incident.runbookRuns.length > 0 ? (
        <ol className="flex flex-col gap-om-2 text-om-2xs" aria-label={t('services.runbook.history')}>
          {incident.runbookRuns.map((r) => (
            <li key={r.id} className="flex flex-wrap gap-om-6">
              <span className="font-om-mono text-om-muted">{format.dateTime(r.at)}</span>
              <span className="text-om-secondary">
                {t('services.runbook.stepN', { order: format.integer(r.order) })}
              </span>
              <span className="text-om-primary">{t(outcomeKey[r.outcome])}</span>
              <span className="text-om-secondary">{r.actor}</span>
              {r.remoteId !== null ? (
                <span className="font-om-mono text-om-muted">
                  {t('services.runbook.remote', { id: r.remoteId })}
                </span>
              ) : null}
              {r.error !== null ? <span className="text-om-rose">{r.error}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {canOperate && open ? (
        <div>
          <Button
            tone="quiet"
            disabled={attach.isPending}
            onClick={() => {
              attach.mutate(null);
            }}
          >
            {t('services.runbook.detach')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
