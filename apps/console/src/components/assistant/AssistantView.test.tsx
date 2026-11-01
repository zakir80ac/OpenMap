// T-104 REQ-UI-018 — Assistant in en and ar: an example prompt or a typed question goes to `askAssistant`, the answer
// shows the text, the Cypher, the rows and linked CIs; a refused question shows the API's reason and rejected Cypher.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';
import type { AuthValue } from '@/lib/auth';
import { Providers } from '@/providers';
import { AssistantView, cell, columnsOf } from './AssistantView';

const authValue = (): AuthValue =>
  ({ status: 'signed-in', user: { subject: 's1', username: 'an', displayName: 'Analyst', email: 'a@bank.local', tenant: 'default', roles: ['openmap-analyst'] }, reason: undefined, reasonDetail: undefined, can: () => true, getAccessToken: () => 'tok', signIn: () => Promise.resolve(undefined), completeSignIn: () => Promise.resolve('/'), signOut: () => Promise.resolve(undefined) }) as unknown as AuthValue;
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal<typeof AuthModule>()), useAuth: () => authValue(), useCan: () => authValue().can }));

const state = { refuse: false, calls: [] as string[] };

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  const op = /^(query|mutation) (\w+)/.exec(body.query)?.[2] ?? 'unknown';
  if (op !== 'AskAssistant') return { errors: [{ message: 'unexpected operation ' + op }] };
  state.calls.push(String(body.variables?.['question']));
  if (state.refuse) return { errors: [{ message: 'generated query writes to the graph', extensions: { cypher: 'MATCH (n) DELETE n' } }] };
  return { data: { askAssistant: { text: '2,002 hosts run Linux.', cypher: 'MATCH (h:Ci {type: "host"}) RETURN count(h) AS hosts', rows: [{ hosts: 2002, os: 'linux' }], cis: [{ id: 'ci-1', name: 'esx-01', displayName: 'esx-01.bank.local', type: 'host', layer: 'hardware', health: 'healthy' }] } } };
}

beforeEach(() => {
  state.refuse = false;
  state.calls = [];
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      return Promise.resolve(new Response(JSON.stringify(respond(JSON.parse(raw) as { query: string; variables?: Record<string, unknown> })), { status: 200, headers: { 'content-type': 'application/json' } }));
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
  it('derives table columns and renders cells', () => {
    expect(columnsOf([{ a: 1 }, { b: 2, a: 3 }])).toEqual(['a', 'b']);
    expect(cell(null)).toBe('');
    expect(cell({ x: 1 })).toBe('{"x":1}');
  });
});

describe.each(LOCALES)('AssistantView (%s)', (locale) => {
  it('answers an example question with text, Cypher, rows and linked CIs', async () => {
    mount(locale);
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'assistant.example.hosts') }));
    await screen.findByText('2,002 hosts run Linux.');
    expect(state.calls).toEqual([translate(locale, 'assistant.example.hosts')]);
    expect(screen.getByText('MATCH (h:Ci {type: "host"}) RETURN count(h) AS hosts')).toBeTruthy();
    expect(screen.getByText('esx-01.bank.local')).toBeTruthy();
    expect(screen.getByText(translate(locale, 'assistant.rows', { count: '1' }))).toBeTruthy();
  });

  it('shows the refusal and the rejected Cypher for a typed question', async () => {
    state.refuse = true;
    mount(locale);
    fireEvent.change(screen.getByLabelText(translate(locale, 'assistant.ask')), { target: { value: 'delete everything' } });
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'assistant.send') }));
    expect((await screen.findByRole('alert')).textContent).toBe(translate(locale, 'assistant.failed', { reason: 'generated query writes to the graph' }));
    expect(screen.getByText('MATCH (n) DELETE n')).toBeTruthy();
  });
});
