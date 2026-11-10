'use client';
// REQ-UI-018 REQ-AI-001 REQ-AI-007 REQ-AI-008 — Assistant: a conversation over the estate (ADR-028). Each question
// goes to `askAssistant` in the console's locale with the open conversation's id, so a follow-up ("and last month?")
// is read against the previous turn; the answer shows the prose, the figures it rests on, the CIs it names, the
// evidence (every retrieval step with its store, query, rows and duration), suggested follow-ups and, when the
// assistant has to ask back, the clarifying question with its choices. The conversation id lives in the URL, so a
// reload brings the thread back from the server; past conversations are listed beside it to open, continue or delete.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ASSISTANT, BSM } from '@openmap/constants';
import type { Locale, MessageKey } from '@openmap/i18n';
import { isMessageKey } from '@openmap/i18n';
import { Card, Kpi, Pill, SectionTitle, Tag, layerColor } from '@openmap/ui';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useId, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import {
  Button,
  TextArea,
  rowClass,
  tableClass,
  tdClass,
  thClass,
  theadClass,
} from '@/components/common/controls';
import { Icon } from '@/components/icons';
import {
  askAssistant,
  conversationQuery,
  conversationsQuery,
  conversationsQueryKey,
  deleteConversation,
  type AssistantAnswer,
  type AssistantEvidence,
  type AssistantTurn,
} from '@/lib/estate-queries';
import { GraphqlRequestError } from '@/lib/graphql';
import { localizedHref } from '@/lib/locale-path';
import { useFormatters, useT } from '@/providers';

export interface AssistantViewProps {
  locale: Locale;
}

/** The URL parameter that names the open conversation (REQ-AI-008). */
export const CONVERSATION_PARAM = 'c';

export interface Turn {
  id: string;
  question: string;
  answer: AssistantAnswer | null;
  error: { message: string; cypher: string | null } | null;
}

/** The example prompts offered on an empty conversation, as i18n keys. */
export const EXAMPLE_KEYS: readonly MessageKey[] = [
  'assistant.example.hosts',
  'assistant.example.memory',
  'assistant.example.cpu',
  'assistant.example.uptime',
  'assistant.example.incidents',
];

/** Column names across every row, first-seen order. */
export function columnsOf(rows: ReadonlyArray<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!out.includes(key)) out.push(key);
  return out;
}

export function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** The API answers a rejected question with its reason and the Cypher it refused to run. */
export function errorOf(err: unknown): { message: string; cypher: string | null } {
  if (err instanceof GraphqlRequestError) {
    const first = err.errors[0];
    const ext = (first?.extensions ?? {}) as {
      cypher?: unknown;
      response?: { cypher?: unknown; message?: unknown };
    };
    const cypher =
      typeof ext.cypher === 'string'
        ? ext.cypher
        : typeof ext.response?.cypher === 'string'
          ? ext.response.cypher
          : null;
    const message =
      typeof ext.response?.message === 'string' ? ext.response.message : (first?.message ?? err.message);
    return { message, cypher };
  }
  return { message: err instanceof Error ? err.message : String(err), cypher: null };
}

/** The intent's label key, falling back to the raw intent when the catalogue lags behind the contract. */
export function intentKey(intent: string): MessageKey | null {
  const key = 'assistant.intent.' + intent;
  return isMessageKey(key) ? key : null;
}

export function formatFigure(locale: Locale, value: number): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: ASSISTANT.decimals }).format(value);
}

/** Server turns become thread turns; the ones a local turn already shows (same turn id) are left out. */
export function mergeTurns(server: readonly AssistantTurn[], local: readonly Turn[]): Turn[] {
  const shown = new Set(local.map((t) => t.answer?.turnId).filter((id): id is string => id !== undefined));
  return [
    ...server
      .filter((t) => !shown.has(t.id))
      .map((t) => ({ id: t.id, question: t.question, answer: t.answer, error: null })),
    ...local,
  ];
}

const summaryClass = 'cursor-pointer text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted';
const preClass =
  'mt-om-6 overflow-x-auto rounded-om-control bg-om-surface3 p-om-10 font-om-mono text-om-2xs text-om-secondary';

function EvidenceList({ evidence }: { evidence: AssistantEvidence[] }): ReactNode {
  const t = useT();
  const format = useFormatters();
  return (
    <details data-testid="assistant-evidence">
      <summary className={summaryClass}>{t('assistant.evidence')}</summary>
      <ol className="mt-om-6 flex flex-col gap-om-6">
        {evidence.map((e, i) => (
          <li key={i} className="flex flex-col gap-om-4">
            <span className="text-om-2xs text-om-secondary">
              {t('assistant.evidence.step', {
                skill: e.skill,
                store: e.store,
                rows: format.integer(e.rows),
                ms: format.integer(e.durationMs),
              })}
            </span>
            {e.error !== null ? (
              <span className="text-om-2xs text-om-rose">
                {t('assistant.evidence.error', { reason: e.error })}
              </span>
            ) : null}
            {e.query !== '' ? <pre className={preClass}>{e.query}</pre> : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

interface LocalTurns {
  /** The conversation (URL id) the local turns were asked in; turns of another conversation are not shown. */
  key: string | null;
  /** The conversation the server opened for a thread started without one, so the turns stay once the URL moves to it. */
  opened: string | null;
  turns: Turn[];
}

const NO_LOCAL_TURNS: LocalTurns = { key: null, opened: null, turns: [] };

export function AssistantView({ locale }: AssistantViewProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const conversationId = params.get(CONVERSATION_PARAM);
  const [question, setQuestion] = useState('');
  // Turns asked in this session, kept beside the server's so a reload shows the same thread.
  const [local, setLocal] = useState<LocalTurns>(NO_LOCAL_TURNS);
  const counter = useRef(0);
  const conversations = useQuery(conversationsQuery());
  const thread = useQuery(conversationQuery(conversationId));
  const localTurns =
    local.key === conversationId || (local.opened !== null && local.opened === conversationId) ? local.turns : [];
  // A follow-up continues the conversation the first answer opened even before the URL has moved to it.
  const activeConversation = conversationId ?? (local.key === null ? local.opened : null);
  const turns = mergeTurns(thread.data?.turns ?? [], localTurns);

  const open = (nextId: string | null): void => {
    const query = new URLSearchParams(params.toString());
    if (nextId === null) query.delete(CONVERSATION_PARAM);
    else query.set(CONVERSATION_PARAM, nextId);
    const search = query.toString();
    router.replace(search === '' ? pathname : pathname + '?' + search, { scroll: false });
  };

  const ask = useMutation({
    mutationFn: ({ text, conversation }: { text: string; turnId: string; conversation: string | null }) =>
      askAssistant(text, locale, conversation),
    onSuccess: async (answer, { turnId, conversation }) => {
      setLocal((state) => ({
        ...state,
        opened: answer.conversationId,
        turns: state.turns.map((x) => (x.id === turnId ? { ...x, answer } : x)),
      }));
      if (conversation === null) open(answer.conversationId);
      await queryClient.invalidateQueries({ queryKey: conversationsQueryKey });
    },
    onError: (err, { turnId }) => {
      setLocal((state) => ({
        ...state,
        turns: state.turns.map((x) => (x.id === turnId ? { ...x, error: errorOf(err) } : x)),
      }));
    },
  });
  const remove = useMutation({
    mutationFn: (target: string) => deleteConversation(target),
    onSuccess: async (_ok, target) => {
      if (target === conversationId) {
        setLocal(NO_LOCAL_TURNS);
        open(null);
      }
      await queryClient.invalidateQueries({ queryKey: conversationsQueryKey });
    },
  });

  const submit = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed === '' || ask.isPending) return;
    counter.current += 1;
    const turnId = 'local-' + String(counter.current);
    setLocal((state) => ({
      key: conversationId,
      opened: state.opened,
      turns: [...localTurns, { id: turnId, question: trimmed, answer: null, error: null }],
    }));
    setQuestion('');
    ask.mutate({ text: trimmed, turnId, conversation: activeConversation });
  };
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    submit(question);
  };
  const startNew = (): void => {
    setLocal(NO_LOCAL_TURNS);
    open(null);
  };

  const renderAnswer = (answer: AssistantAnswer): ReactNode => {
    const key = intentKey(answer.intent);
    return (
      <>
        <p className="text-om-sm text-om-primary">{answer.text}</p>
        {key !== null ? (
          <span className="text-om-2xs text-om-muted" data-testid="assistant-understood">
            {t('assistant.understood', {
              intent: t(key),
              confidence: format.integer(Math.round(answer.confidence * BSM.percentScale)),
            })}
          </span>
        ) : null}
        {!answer.grounded ? (
          <span className="text-om-2xs text-om-muted">{t('assistant.ungrounded')}</span>
        ) : null}
        {answer.clarification !== null ? (
          <div className="flex flex-col gap-om-6" data-testid="assistant-clarification">
            <span className={summaryClass}>{t('assistant.clarifyTitle')}</span>
            <div className="flex flex-wrap gap-om-6">
              {answer.clarification.options.map((option) => (
                <Pill
                  key={option.value}
                  onClick={() => {
                    submit(option.value);
                  }}
                >
                  {option.label}
                </Pill>
              ))}
            </div>
          </div>
        ) : null}
        {answer.figures.length > 0 ? (
          <div
            className="grid grid-cols-2 gap-om-10 md:grid-cols-4"
            aria-label={t('assistant.figures')}
            role="group"
          >
            {answer.figures.slice(0, ASSISTANT.topN).map((figure, i) => (
              <Kpi
                key={figure.label + String(i)}
                label={figure.label}
                value={formatFigure(locale, figure.value)}
                unit={figure.unit}
              />
            ))}
          </div>
        ) : null}
        {answer.cis.length > 0 ? (
          <div className="flex flex-wrap gap-om-6">
            {answer.cis.map((ci) => (
              <Link key={ci.id} href={localizedHref(locale, '/cmdb/' + encodeURIComponent(ci.id))}>
                <Pill
                  icon={
                    <span
                      className="inline-block size-2 rounded-full"
                      style={{ background: layerColor(ci.layer) }}
                    />
                  }
                >
                  {ci.displayName}
                </Pill>
              </Link>
            ))}
          </div>
        ) : null}
        {answer.evidence.length > 0 ? <EvidenceList evidence={answer.evidence} /> : null}
        {answer.cypher !== '' ? (
          <details className="group">
            <summary className={summaryClass}>{t('assistant.cypher')}</summary>
            <pre className={preClass + ' text-om-cyan'}>{answer.cypher}</pre>
          </details>
        ) : null}
        {answer.rows.length > 0 ? (
          <details>
            <summary className={summaryClass}>
              {t('assistant.rows', { count: format.integer(answer.rows.length) })}
            </summary>
            <div className="mt-om-6 overflow-x-auto">
              <table className={tableClass}>
                <thead className={theadClass}>
                  <tr>
                    {columnsOf(answer.rows).map((c) => (
                      <th key={c} scope="col" className={thClass}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {answer.rows.map((row, i) => (
                    <tr key={i} className={rowClass}>
                      {columnsOf(answer.rows).map((c) => (
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
        ) : answer.cypher !== '' ? (
          <Tag>{t('assistant.noRows')}</Tag>
        ) : null}
        {answer.followUps.length > 0 ? (
          <div className="flex flex-col gap-om-6" data-testid="assistant-followups">
            <span className={summaryClass}>{t('assistant.followUps')}</span>
            <div className="flex flex-wrap gap-om-6">
              {answer.followUps.map((follow) => (
                <Pill
                  key={follow}
                  onClick={() => {
                    submit(follow);
                  }}
                >
                  {follow}
                </Pill>
              ))}
            </div>
          </div>
        ) : null}
      </>
    );
  };

  const renderThread = (): ReactNode => {
    if (conversationId !== null && thread.isPending && localTurns.length === 0)
      return (
        <p role="status" className="text-om-sm text-om-secondary">
          {t('assistant.loadingConversation')}
        </p>
      );
    if (conversationId !== null && thread.data === null && localTurns.length === 0)
      return (
        <p role="alert" className="text-om-sm text-om-rose">
          {t('assistant.conversationMissing')}
        </p>
      );
    if (turns.length === 0)
      return (
        <div className="flex flex-col gap-om-10">
          <p className="text-om-sm text-om-secondary">{t('assistant.empty')}</p>
          <div className="flex flex-wrap gap-om-6" role="group" aria-label={t('assistant.examplesLabel')}>
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
      );
    return (
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
                  {turn.error.cypher !== null ? <pre className={preClass}>{turn.error.cypher}</pre> : null}
                </>
              ) : turn.answer !== null ? (
                renderAnswer(turn.answer)
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    );
  };

  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle as="h1" size="lg" eyebrow={t('app.name')} description={t('assistant.subtitle')}>
        {t('assistant.title')}
      </SectionTitle>

      <div className="grid gap-om-24 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <Card padding="16" className="flex flex-col gap-om-10 self-start" as="aside">
          <div className="flex items-center justify-between gap-om-10">
            <h2 className={summaryClass.replace('cursor-pointer ', '')}>{t('assistant.conversations')}</h2>
            <Button tone="quiet" onClick={startNew} disabled={conversationId === null && turns.length === 0}>
              {t('assistant.newConversation')}
            </Button>
          </div>
          {(conversations.data ?? []).length === 0 ? (
            <p className="text-om-xs text-om-secondary">{t('assistant.noConversations')}</p>
          ) : (
            <ul className="flex flex-col gap-om-4" aria-label={t('assistant.conversationList')}>
              {(conversations.data ?? []).map((conversation) => (
                <li
                  key={conversation.id}
                  className={
                    'flex items-start gap-om-6 rounded-om-control px-om-8 py-om-6 ' +
                    (conversation.id === conversationId ? 'bg-om-cyan/10' : 'hover:bg-om-surface3')
                  }
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 flex-col items-start gap-om-2 text-start"
                    aria-current={conversation.id === conversationId ? 'true' : undefined}
                    aria-label={t('assistant.openConversation', { title: conversation.title })}
                    onClick={() => {
                      setLocal(NO_LOCAL_TURNS);
                      open(conversation.id);
                    }}
                  >
                    <span className="w-full truncate text-om-xs text-om-primary">{conversation.title}</span>
                    <span className="text-om-2xs text-om-muted">
                      {t('assistant.turnCount', { count: format.integer(conversation.turnCount) })}
                      {' · '}
                      {format.dateTime(conversation.updatedAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="mt-om-2 rounded-om-control p-om-2 text-om-muted hover:text-om-rose"
                    aria-label={t('assistant.deleteConversation')}
                    disabled={remove.isPending}
                    onClick={() => {
                      remove.mutate(conversation.id);
                    }}
                  >
                    <Icon name="close" className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card padding="24" className="flex min-w-0 flex-col gap-om-16">
          {renderThread()}
          <form onSubmit={onSubmit} className="flex flex-col gap-om-8" aria-label={t('assistant.title')}>
            <label
              htmlFor={id + '-q'}
              className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted"
            >
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
    </div>
  );
}
