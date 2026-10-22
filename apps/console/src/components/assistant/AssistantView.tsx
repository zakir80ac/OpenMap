'use client';
// REQ-UI-018 REQ-AI-001 — Assistant: a conversation over the tenant's graph. Each question goes to `askAssistant`;
// the answer shows the model's text, the exact read-only Cypher that produced it, the rows and the CIs they name,
// so nothing is taken on trust. A refused or failed question shows the API's reason and the Cypher it rejected.
import { useMutation } from '@tanstack/react-query';
import { ASSISTANT } from '@openmap/constants';
import type { Locale, MessageKey } from '@openmap/i18n';
import { Card, Pill, SectionTitle, Tag, layerColor } from '@openmap/ui';
import Link from 'next/link';
import { useId, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Button, TextArea, rowClass, tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { Icon } from '@/components/icons';
import { askAssistant, type AssistantAnswer } from '@/lib/estate-queries';
import { GraphqlRequestError } from '@/lib/graphql';
import { localizedHref } from '@/lib/locale-path';
import { useFormatters, useT } from '@/providers';

export interface AssistantViewProps {
  locale: Locale;
}

export interface Turn {
  id: number;
  question: string;
  answer: AssistantAnswer | null;
  error: { message: string; cypher: string | null } | null;
}

/** The example prompts offered on an empty conversation, as i18n keys. */
export const EXAMPLE_KEYS: readonly MessageKey[] = ['assistant.example.hosts', 'assistant.example.services', 'assistant.example.subnets', 'assistant.example.power'];

/** Column names across every row, first-seen order. */
export function columnsOf(rows: ReadonlyArray<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!out.includes(key)) out.push(key);
  return out;
}

export function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** The API answers a rejected question with its reason and the Cypher it refused to run. */
export function errorOf(err: unknown): { message: string; cypher: string | null } {
  if (err instanceof GraphqlRequestError) {
    const first = err.errors[0];
    const ext = (first?.extensions ?? {}) as { cypher?: unknown; response?: { cypher?: unknown; message?: unknown } };
    const cypher = typeof ext.cypher === 'string' ? ext.cypher : typeof ext.response?.cypher === 'string' ? ext.response.cypher : null;
    const message = typeof ext.response?.message === 'string' ? ext.response.message : (first?.message ?? err.message);
    return { message, cypher };
  }
  return { message: err instanceof Error ? err.message : String(err), cypher: null };
}

export function AssistantView({ locale }: AssistantViewProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const counter = useRef(0);
  const ask = useMutation({
    mutationFn: ({ text }: { text: string; turnId: number }) => askAssistant(text),
    onSuccess: (answer, { turnId }) => {
      setTurns((list) => list.map((x) => (x.id === turnId ? { ...x, answer } : x)));
    },
    onError: (err, { turnId }) => {
      setTurns((list) => list.map((x) => (x.id === turnId ? { ...x, error: errorOf(err) } : x)));
    },
  });

  const submit = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed === '' || ask.isPending) return;
    counter.current += 1;
    const turnId = counter.current;
    setTurns((list) => [...list, { id: turnId, question: trimmed, answer: null, error: null }]);
    setQuestion('');
    ask.mutate({ text: trimmed, turnId });
  };
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    submit(question);
  };

  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle as="h1" size="lg" eyebrow={t('app.name')} description={t('assistant.subtitle')}>
        {t('assistant.title')}
      </SectionTitle>

      <Card padding="24" className="flex flex-col gap-om-16">
        {turns.length === 0 ? (
          <div className="flex flex-col gap-om-10">
            <p className="text-om-sm text-om-secondary">{t('assistant.empty')}</p>
            <div className="flex flex-wrap gap-om-6">
              {EXAMPLE_KEYS.map((key) => (
                <Pill
                  key={key}
                  onClick={() => {
                    submit(t(key));
                  }}
                >
                  {t(key)}
                </Pill>
              ))}
            </div>
          </div>
        ) : (
          <ol className="flex flex-col gap-om-16" aria-label={t('assistant.conversation')} aria-live="polite">
            {turns.map((turn) => (
              <li key={turn.id} className="flex flex-col gap-om-10">
                <div className="flex items-start gap-om-10">
                  <span className="mt-1 grid size-6 shrink-0 place-items-center rounded-full bg-om-cyan/15 text-om-cyan">
                    <Icon name="user" className="size-3.5" />
                  </span>
                  <p className="text-om-sm text-om-primary">{turn.question}</p>
                </div>
                <div className="ms-8 flex flex-col gap-om-10 rounded-om-panel border border-om-border-glass bg-om-surface2 p-om-16">
                  {turn.answer === null && turn.error === null ? (
                    <p role="status" className="text-om-sm text-om-secondary">
                      {t('assistant.thinking')}
                    </p>
                  ) : turn.error !== null ? (
                    <>
                      <p role="alert" className="text-om-sm text-om-rose">
                        {t('assistant.failed', { reason: turn.error.message })}
                      </p>
                      {turn.error.cypher !== null ? <pre className="overflow-x-auto rounded-om-control bg-om-surface3 p-om-10 font-om-mono text-om-2xs text-om-secondary">{turn.error.cypher}</pre> : null}
                    </>
                  ) : turn.answer !== null ? (
                    <>
                      <p className="text-om-sm text-om-primary">{turn.answer.text}</p>
                      <details className="group">
                        <summary className="cursor-pointer text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('assistant.cypher')}</summary>
                        <pre className="mt-om-6 overflow-x-auto rounded-om-control bg-om-surface3 p-om-10 font-om-mono text-om-2xs text-om-cyan">{turn.answer.cypher}</pre>
                      </details>
                      {turn.answer.cis.length > 0 ? (
                        <div className="flex flex-wrap gap-om-6">
                          {turn.answer.cis.map((ci) => (
                            <Link key={ci.id} href={localizedHref(locale, '/cmdb/' + encodeURIComponent(ci.id))}>
                              <Pill icon={<span className="inline-block size-2 rounded-full" style={{ background: layerColor(ci.layer) }} />}>{ci.displayName}</Pill>
                            </Link>
                          ))}
                        </div>
                      ) : null}
                      {turn.answer.rows.length > 0 ? (
                        <details>
                          <summary className="cursor-pointer text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('assistant.rows', { count: format.integer(turn.answer.rows.length) })}</summary>
                          <div className="mt-om-6 overflow-x-auto">
                            <table className={tableClass}>
                              <thead className={theadClass}>
                                <tr>
                                  {columnsOf(turn.answer.rows).map((c) => (
                                    <th key={c} scope="col" className={thClass}>
                                      {c}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {turn.answer.rows.map((row, i) => (
                                  <tr key={i} className={rowClass}>
                                    {columnsOf(turn.answer?.rows ?? []).map((c) => (
                                      <td key={c} className={tdClass + ' font-om-mono text-om-secondary'}>
                                        {cell(row[c])}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </details>
                      ) : (
                        <Tag>{t('assistant.noRows')}</Tag>
                      )}
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
        <form onSubmit={onSubmit} className="flex flex-col gap-om-8" aria-label={t('assistant.title')}>
          <label htmlFor={id + '-q'} className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
            {t('assistant.ask')}
          </label>
          <TextArea
            id={id + '-q'}
            value={question}
            maxLength={ASSISTANT.maxQuestionLength}
            onChange={(event) => {
              setQuestion(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit(question);
              }
            }}
          />
          <div className="flex items-center gap-om-10">
            <Button type="submit" disabled={question.trim() === '' || ask.isPending}>
              {ask.isPending ? t('assistant.thinking') : t('assistant.send')}
            </Button>
            <span className="text-om-2xs text-om-muted">{t('assistant.hint')}</span>
          </div>
        </form>
      </Card>
    </div>
  );
}
