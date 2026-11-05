// T-104 T-144 T-147 REQ-UI-018 REQ-AI-007 REQ-AI-008 — Assistant in en and ar: an example prompt or a typed question
// goes to `askAssistant` with the locale and the open conversation's id; the answer shows the prose, the figures, the
// evidence steps, the linked CIs and the follow-ups; a follow-up or a clarification choice is asked as the next
// question in the same conversation; a refused question shows the API's reason and rejected Cypher; an ungrounded
// answer says so. T-147: the first answer puts the conversation id in the URL, a conversation named in the URL is
// loaded from the server with its turns, the list opens and deletes conversations.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';
import type { AuthValue } from '@/lib/auth';
import { Providers } from '@/providers';
import { AssistantView, cell, columnsOf, formatFigure, intentKey, mergeTurns } from './AssistantView';

const replace = vi.fn();
const navigation = { search: '' };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigation.search),
  usePathname: () => '/en/assistant',
}));

const authValue = (): AuthValue =>
  ({
    status: 'signed-in',
    user: {
      subject: 's1',
      username: 'an',
      displayName: 'Analyst',
      email: 'a@bank.local',
      tenant: 'default',
      roles: ['openmap-analyst'],
    },
    reason: undefined,
    reasonDetail: undefined,
    can: () => true,
    getAccessToken: () => 'tok',
    signIn: () => Promise.resolve(undefined),
    completeSignIn: () => Promise.resolve('/'),
    signOut: () => Promise.resolve(undefined),
  }) as unknown as AuthValue;
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  useAuth: () => authValue(),
  useCan: () => authValue().can,
}));

type Mode = 'answer' | 'refuse' | 'clarify' | 'ungrounded';
const state = {
  mode: 'answer' as Mode,
  calls: [] as Array<{ question: string; locale: string; conversationId: string | null }>,
  deleted: [] as string[],
};
const CONVERSATION_ID = '0f4b2b2a-6c2e-4e3a-9b4e-1a2b3c4d5e6f';
const OTHER_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const conversations = [
  { id: CONVERSATION_ID, title: 'How many hosts run each operating system?', createdAt: '2026-11-05T09:00:00.000Z', updatedAt: '2026-11-05T09:05:00.000Z', turnCount: 2 },
  { id: OTHER_ID, title: 'Which incidents are open?', createdAt: '2026-11-04T09:00:00.000Z', updatedAt: '2026-11-04T09:00:00.000Z', turnCount: 1 },
];

const evidence = [
  {
    skill: 'cmdb.attributes',
    store: 'postgres',
    query: 'SELECT count(*)::int AS "count" FROM cis c WHERE c."tenantId" = $1::uuid',
    params: { $1: 't' },
    rows: 1,
    durationMs: 12,
    error: null,
  },
  {
    skill: 'metrics.latest',
    store: 'clickhouse',
    query: '',
    params: {},
    rows: 0,
    durationMs: 20_000,
    error: 'metrics.latest timed out after 20000 ms',
  },
];
const cis = [
  {
    id: 'ci-1',
    name: 'esx-01',
    displayName: 'esx-01.bank.local',
    type: 'host',
    layer: 'hardware',
    health: 'healthy',
  },
];

function answer(mode: Mode): Record<string, unknown> {
  if (mode === 'clarify') {
    return {
      text: 'Which ledger do you mean?',
      cypher: '',
      rows: [],
      cis: [],
      intent: 'impact',
      confidence: 0.9,
      grounded: true,
      figures: [],
      evidence: [],
      followUps: [],
      clarification: {
        question: 'Which ledger do you mean?',
        options: [{ label: 'Ledger DB (DB-LEDGER)', value: 'which services depend on DB-LEDGER' }],
      },
      conversationId: CONVERSATION_ID,
      turnId: 'turn-clarify',
    };
  }
  return {
    text: 'There are 2,002 hosts, averaging 254.5 GB of memory.',
    cypher: mode === 'answer' ? 'MATCH (h:Ci {type: "host"}) RETURN count(h) AS hosts' : '',
    rows: mode === 'answer' ? [{ hosts: 2002, os: 'linux' }] : [],
    cis,
    intent: 'count',
    confidence: 0.85,
    grounded: mode !== 'ungrounded',
    figures: [
      { label: 'hosts', value: 2002, unit: '' },
      { label: 'average memory', value: 254.5, unit: 'GB' },
    ],
    evidence,
    followUps: ['How many hosts per site?', 'Which hosts are down?'],
    clarification: null,
    conversationId: CONVERSATION_ID,
    turnId: 'turn-' + String(state.calls.length),
  };
}

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  const op = /^(query|mutation) (\w+)/.exec(body.query)?.[2] ?? 'unknown';
  if (op === 'Conversations')
    return { data: { conversations: conversations.filter((c) => !state.deleted.includes(c.id)) } };
  if (op === 'Conversation') {
    const id = String(body.variables?.['id']);
    const found = conversations.find((c) => c.id === id && !state.deleted.includes(c.id));
    if (found === undefined) return { data: { conversation: null } };
    return {
      data: {
        conversation: {
          ...found,
          turns: [
            { id: 'stored-1', at: found.createdAt, question: found.title, locale: 'en', answer: { ...answer('answer'), turnId: 'stored-1' } },
            { id: 'stored-2', at: found.updatedAt, question: 'And per site?', locale: 'en', answer: { ...answer('answer'), text: 'There are 1,000 hosts in RYD and 1,002 in JED.', turnId: 'stored-2' } },
          ],
        },
      },
    };
  }
  if (op === 'DeleteConversation') {
    state.deleted.push(String(body.variables?.['id']));
    return { data: { deleteConversation: true } };
  }
  if (op !== 'AskAssistant') return { errors: [{ message: 'unexpected operation ' + op }] };
  const conversationId = body.variables?.['conversationId'];
  state.calls.push({
    question: String(body.variables?.['question']),
    locale: String(body.variables?.['locale']),
    conversationId: typeof conversationId === 'string' ? conversationId : null,
  });
  if (state.mode === 'refuse')
    return {
      errors: [
        { message: 'generated query writes to the graph', extensions: { cypher: 'MATCH (n) DELETE n' } },
      ],
    };
  return { data: { askAssistant: answer(state.mode) } };
}

beforeEach(() => {
  state.mode = 'answer';
  state.calls = [];
  state.deleted = [];
  navigation.search = '';
  replace.mockClear();
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      return Promise.resolve(
        new Response(
          JSON.stringify(respond(JSON.parse(raw) as { query: string; variables?: Record<string, unknown> })),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(locale: (typeof LOCALES)[number]): void {
  render(
    <Providers locale={locale}>
      <AssistantView locale={locale} />
    </Providers>,
  );
}

describe('AssistantView helpers', () => {
  it('derives table columns, renders cells, formats figures and resolves intent keys', () => {
    expect(columnsOf([{ a: 1 }, { b: 2, a: 3 }])).toEqual(['a', 'b']);
    expect(cell(null)).toBe('');
    expect(cell({ x: 1 })).toBe('{"x":1}');
    expect(formatFigure('en', 254.5)).toBe('254.5');
    expect(formatFigure('en', 2002)).toBe('2,002');
    expect(intentKey('count')).toBe('assistant.intent.count');
    expect(intentKey('made-up')).toBeNull();
  });
  it('merges server turns with the local ones without showing a turn twice', () => {
    const local = [{ id: 'local-1', question: 'q2', answer: { ...answer('answer'), turnId: 'stored-2' } as never, error: null }];
    const merged = mergeTurns(
      [
        { id: 'stored-1', at: '', question: 'q1', locale: 'en', answer: answer('answer') as never },
        { id: 'stored-2', at: '', question: 'q2', locale: 'en', answer: answer('answer') as never },
      ],
      local,
    );
    expect(merged.map((t) => t.id)).toEqual(['stored-1', 'local-1']);
  });
});

describe.each(LOCALES)('AssistantView (%s)', (locale) => {
  it('answers an example question with prose, figures, evidence, linked CIs and follow-ups in the locale', async () => {
    mount(locale);
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'assistant.example.hosts') }));
    await screen.findByText('There are 2,002 hosts, averaging 254.5 GB of memory.');
    expect(state.calls).toEqual([
      { question: translate(locale, 'assistant.example.hosts'), locale, conversationId: null },
    ]);
    // REQ-AI-008: the first answer opens a conversation and puts its id in the URL.
    expect(replace).toHaveBeenCalledWith('/en/assistant?c=' + CONVERSATION_ID, { scroll: false });
    expect(screen.getByText('esx-01.bank.local')).toBeTruthy();
    expect(
      screen.getByText(
        translate(locale, 'assistant.understood', {
          intent: translate(locale, 'assistant.intent.count'),
          confidence: '85',
        }),
      ),
    ).toBeTruthy();
    const figures = screen.getByRole('group', { name: translate(locale, 'assistant.figures') });
    expect(within(figures).getByText('average memory')).toBeTruthy();
    const evidenceBlock = screen.getByTestId('assistant-evidence');
    expect(
      within(evidenceBlock).getByText(
        translate(locale, 'assistant.evidence.step', {
          skill: 'cmdb.attributes',
          store: 'postgres',
          rows: '1',
          ms: '12',
        }),
      ),
    ).toBeTruthy();
    expect(
      within(evidenceBlock).getByText(
        translate(locale, 'assistant.evidence.error', { reason: 'metrics.latest timed out after 20000 ms' }),
      ),
    ).toBeTruthy();
    expect(screen.getByText('MATCH (h:Ci {type: "host"}) RETURN count(h) AS hosts')).toBeTruthy();
    expect(screen.getByText(translate(locale, 'assistant.rows', { count: '1' }))).toBeTruthy();
    expect(screen.queryByText(translate(locale, 'assistant.ungrounded'))).toBeNull();
    fireEvent.click(
      within(screen.getByTestId('assistant-followups')).getByRole('button', {
        name: 'How many hosts per site?',
      }),
    );
    await screen.findAllByText('There are 2,002 hosts, averaging 254.5 GB of memory.');
    expect(state.calls[1]?.question).toBe('How many hosts per site?');
    // The follow-up continues the conversation the first answer opened.
    expect(state.calls[1]?.conversationId).toBe(CONVERSATION_ID);
  });

  it('loads the conversation named in the URL with its turns, and continues it (REQ-AI-008)', async () => {
    navigation.search = 'c=' + CONVERSATION_ID;
    mount(locale);
    await screen.findByText('There are 1,000 hosts in RYD and 1,002 in JED.');
    const conversation = screen.getByRole('list', { name: translate(locale, 'assistant.conversation') });
    // Evidence steps are list items of their own; the thread's turns are the direct children.
    expect(conversation.querySelectorAll(':scope > li')).toHaveLength(2);
    expect(within(conversation).getByText('And per site?')).toBeTruthy();
    const list = await screen.findByRole('list', { name: translate(locale, 'assistant.conversationList') });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText(translate(locale, 'assistant.turnCount', { count: '2' }), { exact: false })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(translate(locale, 'assistant.ask')), {
      target: { value: 'and last month?' },
    });
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'assistant.send') }));
    await screen.findAllByText('There are 2,002 hosts, averaging 254.5 GB of memory.');
    expect(state.calls).toEqual([{ question: 'and last month?', locale, conversationId: CONVERSATION_ID }]);
    expect(conversation.querySelectorAll(':scope > li')).toHaveLength(3);
  });

  it('opens another conversation from the list, starts a new one and deletes one (REQ-AI-008)', async () => {
    navigation.search = 'c=' + CONVERSATION_ID;
    mount(locale);
    const list = await screen.findByRole('list', { name: translate(locale, 'assistant.conversationList') });
    fireEvent.click(
      within(list).getByRole('button', {
        name: translate(locale, 'assistant.openConversation', { title: 'Which incidents are open?' }),
      }),
    );
    expect(replace).toHaveBeenLastCalledWith('/en/assistant?c=' + OTHER_ID, { scroll: false });
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'assistant.newConversation') }));
    expect(replace).toHaveBeenLastCalledWith('/en/assistant', { scroll: false });
    fireEvent.click(within(list).getAllByRole('button', { name: translate(locale, 'assistant.deleteConversation') })[0] as HTMLElement);
    await screen.findByText('Which incidents are open?');
    expect(state.deleted).toEqual([CONVERSATION_ID]);
    expect(within(list).queryByText('How many hosts run each operating system?')).toBeNull();
  });

  it('says when the conversation in the URL no longer exists', async () => {
    navigation.search = 'c=5d1c0f0e-0000-4000-8000-000000000000';
    mount(locale);
    await screen.findByText(translate(locale, 'assistant.conversationMissing'));
  });

  it('asks the clarifying question and re-asks with the chosen option', async () => {
    state.mode = 'clarify';
    mount(locale);
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'assistant.example.hosts') }));
    const block = await screen.findByTestId('assistant-clarification');
    expect(screen.getAllByText('Which ledger do you mean?').length).toBeGreaterThan(0);
    fireEvent.click(within(block).getByRole('button', { name: 'Ledger DB (DB-LEDGER)' }));
    await screen.findAllByTestId('assistant-clarification');
    expect(state.calls[1]?.question).toBe('which services depend on DB-LEDGER');
  });

  it('says when the wording fell back to the figures and shows the refusal for a rejected question', async () => {
    state.mode = 'ungrounded';
    mount(locale);
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'assistant.example.cpu') }));
    await screen.findByText(translate(locale, 'assistant.ungrounded'));
    expect(screen.queryByText(translate(locale, 'assistant.cypher'))).toBeNull();
    state.mode = 'refuse';
    fireEvent.change(screen.getByLabelText(translate(locale, 'assistant.ask')), {
      target: { value: 'delete everything' },
    });
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'assistant.send') }));
    await screen.findByRole('alert');
    expect(screen.getByText('MATCH (n) DELETE n')).toBeTruthy();
    expect(state.calls[1]).toEqual({ question: 'delete everything', locale, conversationId: CONVERSATION_ID });
  });
});
