'use client';
// REQ-BSM-005 REQ-UI-013 (ADR-048) — the tenant's runbook catalogue on the Impact screen: every runbook with its
// steps and recovery estimate (the sum of the step minutes), and an editor where an operator writes the steps. A step
// may name a SOAR or automation integration and the playbook or job template it triggers.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RUNBOOK_AUTOMATION_CATEGORIES } from '@openmap/contracts';
import { ROLES } from '@openmap/constants';
import { Card, SectionTitle, Tag } from '@openmap/ui';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Button, Field, Select, TextInput } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { useCan } from '@/lib/auth';
import { integrationsQuery } from '@/lib/estate-queries';
import {
  deleteRunbook,
  runbooksQuery,
  setScenarioRunbook,
  upsertRunbook,
  type ImpactScenario,
  type Runbook,
  type RunbookInput,
} from '@/lib/queries';
import { useFormatters, useT } from '@/providers';

interface StepDraft {
  instruction: string;
  minutes: string;
  integrationId: string;
  action: string;
}

interface Draft {
  id: string | null;
  code: string;
  title: string;
  ownerTeam: string;
  lastReviewedAt: string;
  steps: StepDraft[];
}

const emptyStep = (): StepDraft => ({ instruction: '', minutes: '', integrationId: '', action: '' });
const emptyDraft = (): Draft => ({
  id: null,
  code: '',
  title: '',
  ownerTeam: '',
  lastReviewedAt: '',
  steps: [emptyStep()],
});

function draftOf(r: Runbook): Draft {
  return {
    id: r.id,
    code: r.code,
    title: r.title,
    ownerTeam: r.ownerTeam,
    lastReviewedAt: r.lastReviewedAt ?? '',
    steps: r.steps.map((s) => ({
      instruction: s.instruction,
      minutes: s.estimatedMinutes === null ? '' : String(s.estimatedMinutes),
      integrationId: s.automation?.integration?.id ?? '',
      action: s.automation?.action ?? '',
    })),
  };
}

/** The draft as the API takes it; steps are numbered in the order shown, blank rows are dropped. */
export function inputOf(d: Draft): RunbookInput {
  return {
    code: d.code.trim(),
    title: d.title.trim(),
    ownerTeam: d.ownerTeam.trim(),
    lastReviewedAt: d.lastReviewedAt === '' ? null : d.lastReviewedAt,
    steps: d.steps
      .filter((s) => s.instruction.trim() !== '')
      .map((s, index) => ({
        order: index + 1,
        instruction: s.instruction.trim(),
        estimatedMinutes:
          s.minutes.trim() === '' || !Number.isFinite(Number(s.minutes))
            ? null
            : Math.max(0, Math.round(Number(s.minutes))),
        automation:
          s.integrationId === '' || s.action.trim() === ''
            ? null
            : { integrationId: s.integrationId, action: s.action.trim() },
      })),
  };
}

export function RunbooksPanel(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const can = useCan();
  const operator = can(ROLES.operator);
  const queryClient = useQueryClient();
  const runbooks = useQuery(runbooksQuery());
  const integrations = useQuery({ ...integrationsQuery(null), enabled: operator });
  const automations = (integrations.data ?? []).filter((i) =>
    (RUNBOOK_AUTOMATION_CATEGORIES as readonly string[]).includes(i.category),
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['runbooks'] });
    void queryClient.invalidateQueries({ queryKey: ['impact-scenarios'] });
  };
  const save = useMutation({
    mutationFn: (d: Draft) => upsertRunbook(d.id, inputOf(d)),
    onSuccess: () => {
      setDraft(null);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (runbookId: string) => deleteRunbook(runbookId),
    onSuccess: refresh,
  });
  const minutes = (value: number | null): string =>
    value === null
      ? t('services.runbook.noEstimate')
      : t('services.runbook.minutes', { minutes: format.integer(value) });
  const setStep = (index: number, patch: Partial<StepDraft>): void => {
    setDraft((d) =>
      d === null ? d : { ...d, steps: d.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)) },
    );
  };
  const valid =
    draft !== null &&
    inputOf(draft).code !== '' &&
    inputOf(draft).title !== '' &&
    inputOf(draft).ownerTeam !== '' &&
    inputOf(draft).steps.length > 0;

  const submit = (e: SyntheticEvent): void => {
    e.preventDefault();
    if (draft !== null && valid) save.mutate(draft);
  };

  return (
    <section aria-label={t('impact.runbooks.title')}>
      <Card className="flex flex-col gap-om-12">
        <SectionTitle
          as="h2"
          size="sm"
          description={t('impact.runbooks.description')}
          action={
            operator && draft === null ? (
              <Button
                onClick={() => {
                  setDraft(emptyDraft());
                }}
              >
                {t('impact.runbooks.new')}
              </Button>
            ) : null
          }
        >
          {t('impact.runbooks.title')}
        </SectionTitle>
        {draft !== null ? (
          <form
            onSubmit={submit}
            aria-label={t('impact.runbooks.editor')}
            className="flex flex-col gap-om-8 rounded-om-panel border border-om-border-strong bg-om-surface3 p-om-10"
          >
            <div className="grid gap-om-8 md:grid-cols-4">
              <Field id={id + '-code'} label={t('impact.runbooks.code')}>
                <TextInput
                  id={id + '-code'}
                  value={draft.code}
                  onChange={(e) => {
                    setDraft({ ...draft, code: e.target.value });
                  }}
                />
              </Field>
              <Field id={id + '-title'} label={t('impact.runbooks.name')}>
                <TextInput
                  id={id + '-title'}
                  value={draft.title}
                  onChange={(e) => {
                    setDraft({ ...draft, title: e.target.value });
                  }}
                />
              </Field>
              <Field id={id + '-owner'} label={t('impact.runbooks.owner')}>
                <TextInput
                  id={id + '-owner'}
                  value={draft.ownerTeam}
                  onChange={(e) => {
                    setDraft({ ...draft, ownerTeam: e.target.value });
                  }}
                />
              </Field>
              <Field id={id + '-reviewed'} label={t('impact.runbooks.reviewed')}>
                <TextInput
                  id={id + '-reviewed'}
                  type="date"
                  value={draft.lastReviewedAt}
                  onChange={(e) => {
                    setDraft({ ...draft, lastReviewedAt: e.target.value });
                  }}
                />
              </Field>
            </div>
            <ol className="flex flex-col gap-om-6" aria-label={t('impact.runbooks.steps')}>
              {draft.steps.map((step, index) => (
                <li key={index} className="grid items-end gap-om-6 md:grid-cols-[2fr_6rem_1fr_1fr_auto]">
                  <Field
                    id={id + '-step-' + String(index)}
                    label={t('impact.runbooks.step', { order: format.integer(index + 1) })}
                  >
                    <TextInput
                      id={id + '-step-' + String(index)}
                      value={step.instruction}
                      onChange={(e) => {
                        setStep(index, { instruction: e.target.value });
                      }}
                    />
                  </Field>
                  <Field id={id + '-min-' + String(index)} label={t('impact.runbooks.stepMinutes')}>
                    <TextInput
                      id={id + '-min-' + String(index)}
                      inputMode="numeric"
                      value={step.minutes}
                      onChange={(e) => {
                        setStep(index, { minutes: e.target.value });
                      }}
                    />
                  </Field>
                  <Field id={id + '-int-' + String(index)} label={t('impact.runbooks.integration')}>
                    <Select
                      id={id + '-int-' + String(index)}
                      value={step.integrationId}
                      onChange={(e) => {
                        setStep(index, { integrationId: e.target.value });
                      }}
                    >
                      <option value="">{t('impact.runbooks.manual')}</option>
                      {automations.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field id={id + '-act-' + String(index)} label={t('impact.runbooks.action')}>
                    <TextInput
                      id={id + '-act-' + String(index)}
                      value={step.action}
                      disabled={step.integrationId === ''}
                      onChange={(e) => {
                        setStep(index, { action: e.target.value });
                      }}
                    />
                  </Field>
                  <Button
                    tone="quiet"
                    disabled={draft.steps.length === 1}
                    aria-label={t('impact.runbooks.removeStep', { order: format.integer(index + 1) })}
                    onClick={() => {
                      setDraft({ ...draft, steps: draft.steps.filter((_, i) => i !== index) });
                    }}
                  >
                    {t('impact.runbooks.remove')}
                  </Button>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-om-6">
              <Button
                tone="quiet"
                onClick={() => {
                  setDraft({ ...draft, steps: [...draft.steps, emptyStep()] });
                }}
              >
                {t('impact.runbooks.addStep')}
              </Button>
              <span className="flex-1" />
              <Button
                tone="quiet"
                onClick={() => {
                  setDraft(null);
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={!valid || save.isPending}>
                {t('impact.runbooks.save')}
              </Button>
            </div>
            {save.isError ? (
              <p role="alert" className="text-om-xs text-om-rose">
                {t('services.runbook.error')}
              </p>
            ) : null}
          </form>
        ) : null}
        {runbooks.isPending ? (
          <QueryState status="pending" />
        ) : runbooks.isError ? (
          <QueryState
            status="error"
            onRetry={() => {
              void runbooks.refetch();
            }}
          />
        ) : runbooks.data.length === 0 ? (
          <p className="text-om-sm text-om-secondary">{t('impact.runbooks.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-om-6" aria-label={t('impact.runbooks.list')}>
            {runbooks.data.map((r) => (
              <li
                key={r.id}
                className="flex flex-col gap-om-4 rounded-om-panel border border-om-border-glass bg-om-surface2/60 px-om-10 py-om-8 text-om-sm"
              >
                <div className="flex flex-wrap items-center gap-om-8">
                  <span className="min-w-0 flex-1 font-medium text-om-primary">
                    {r.code + ' · ' + r.title}
                  </span>
                  <Tag>{minutes(r.estimatedMinutes)}</Tag>
                  <span className="text-om-2xs text-om-muted">{r.ownerTeam}</span>
                  {operator ? (
                    <>
                      <Button
                        tone="quiet"
                        onClick={() => {
                          setDraft(draftOf(r));
                        }}
                      >
                        {t('impact.runbooks.edit')}
                      </Button>
                      <Button
                        tone="quiet"
                        disabled={remove.isPending}
                        onClick={() => {
                          remove.mutate(r.id);
                        }}
                      >
                        {t('impact.runbooks.delete')}
                      </Button>
                    </>
                  ) : null}
                </div>
                <ol className="flex flex-col gap-om-2 text-om-2xs text-om-secondary">
                  {r.steps.map((s) => (
                    <li key={s.order}>
                      {t('impact.runbooks.stepLine', {
                        order: format.integer(s.order),
                        instruction: s.instruction,
                      })}
                      {s.estimatedMinutes !== null ? ' · ' + minutes(s.estimatedMinutes) : ''}
                      {s.automation !== null
                        ? ' · ' +
                          t('services.runbook.automation', {
                            integration:
                              s.automation.integration?.name ?? t('services.runbook.missingIntegration'),
                            action: s.automation.action,
                          })
                        : ''}
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

/** A saved scenario's runbook: shown to everyone, chosen from the catalogue by an operator. */
export function ScenarioRunbookPicker({ scenario }: { scenario: ImpactScenario }): ReactNode {
  const t = useT();
  const id = useId();
  const can = useCan();
  const queryClient = useQueryClient();
  const operator = can(ROLES.operator);
  const runbooks = useQuery({ ...runbooksQuery(), enabled: operator });
  const attach = useMutation({
    mutationFn: (runbookId: string | null) => setScenarioRunbook(scenario.id, runbookId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['impact-scenarios'] });
    },
  });
  if (!operator || runbooks.data === undefined) {
    return scenario.runbook === null ? null : <Tag>{scenario.runbook.code}</Tag>;
  }
  return (
    <span className="flex items-center gap-om-4">
      <label htmlFor={id} className="sr-only">
        {t('impact.runbooks.forScenario', { name: scenario.name })}
      </label>
      <Select
        id={id}
        className="w-auto py-om-2 text-om-2xs"
        value={scenario.runbook?.id ?? ''}
        disabled={attach.isPending}
        onChange={(e) => {
          attach.mutate(e.target.value === '' ? null : e.target.value);
        }}
      >
        <option value="">{t('impact.runbooks.noRunbook')}</option>
        {runbooks.data.map((r) => (
          <option key={r.id} value={r.id}>
            {r.code}
          </option>
        ))}
      </Select>
    </span>
  );
}
