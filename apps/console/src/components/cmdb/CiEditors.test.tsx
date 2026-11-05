// T-162 REQ-CMDB-013 REQ-CMDB-016 — the CI editors in en and ar: an operator moves the CI's lifecycle with the select,
// removes a tag with its button and adds one from the field (suggested from the tenant's tags), and a malformed tag is
// refused before it is sent; a viewer sees the lifecycle and the tags without controls.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';
import { Providers } from '@/providers';
import { LifecycleField, TagEditor } from './CiEditors';

const role = vi.hoisted(() => ({ operator: true }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  useCan: () => () => role.operator,
}));

const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  calls.push({ query: body.query, variables: body.variables ?? {} });
  if (body.query.includes('mutation SetCiLifecycle(')) return { data: { setCiLifecycle: { id: 'h1', lifecycle: body.variables?.['lifecycle'] } } };
  if (body.query.includes('mutation SetCiTags(')) return { data: { setCiTags: { id: 'h1', tags: body.variables?.['tags'] } } };
  if (body.query.includes('query CiTags')) return { data: { ciTags: [{ tag: 'pci', count: 4 }, { tag: 'ledger', count: 2 }] } };
  return { errors: [{ message: 'unexpected operation' }] };
}

beforeEach(() => {
  role.operator = true;
  calls.length = 0;
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      return Promise.resolve(new Response(JSON.stringify(respond(JSON.parse(raw) as { query: string })), { status: 200, headers: { 'content-type': 'application/json' } }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ci = { id: 'h1', lifecycle: 'discovered' as const, tags: ['pci', 'prod'] };

describe.each(LOCALES)('CI editors (%s)', (locale) => {
  function mount(): void {
    render(
      <Providers locale={locale}>
        <LifecycleField ci={ci} />
        <TagEditor ci={ci} />
      </Providers>,
    );
  }

  it('lets an operator change the lifecycle and edit the tags', async () => {
    mount();
    fireEvent.change(screen.getByRole('combobox', { name: translate(locale, 'cmdb.detail.lifecycle') }), { target: { value: 'managed' } });
    await waitFor(() => {
      expect(calls.find((c) => c.query.includes('SetCiLifecycle'))?.variables).toEqual({ ciId: 'h1', lifecycle: 'managed' });
    });
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'cmdb.detail.tagRemove', { tag: 'prod' }) }));
    await waitFor(() => {
      expect(calls.filter((c) => c.query.includes('SetCiTags')).at(-1)?.variables).toEqual({ ciId: 'h1', tags: ['pci'] });
    });
    const field = screen.getByRole('combobox', { name: translate(locale, 'cmdb.detail.tagAdd') });
    fireEvent.change(field, { target: { value: 'has space' } });
    expect(screen.getByText(translate(locale, 'cmdb.detail.tagInvalid'))).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: translate(locale, 'cmdb.detail.tagAddButton') }).disabled).toBe(true);
    fireEvent.change(field, { target: { value: 'ledger' } });
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'cmdb.detail.tagAddButton') }));
    await waitFor(() => {
      expect(calls.filter((c) => c.query.includes('SetCiTags')).at(-1)?.variables).toEqual({ ciId: 'h1', tags: ['pci', 'prod', 'ledger'] });
    });
    const list = document.getElementById(field.getAttribute('list') ?? '');
    await waitFor(() => {
      expect(within(list as HTMLElement).getAllByRole('option', { hidden: true }).map((o) => o.getAttribute('value'))).toEqual(['pci', 'ledger']);
    });
  });

  it('shows a viewer the lifecycle and tags without controls', () => {
    role.operator = false;
    mount();
    expect(screen.getByText(translate(locale, 'lifecycle.discovered'))).toBeTruthy();
    expect(screen.getByText('prod')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
