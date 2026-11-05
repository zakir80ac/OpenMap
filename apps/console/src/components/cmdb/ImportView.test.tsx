// T-171 REQ-CMDB-033 REQ-CMDB-036 — the import screen in en and ar: choosing a file previews it with the mapping the API
// proposes; the summary, the refused rows and the per-column targets are shown; changing a column's target and the
// default type and checking again sends the edited mapping; importing sends the same file and mapping and refreshes
// the job list; a non-operator sees the jobs only. The helpers derive the column targets and the file format.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';
import { Providers } from '@/providers';
import { ImportView, formatOf, targetsFor } from './ImportView';

const role = vi.hoisted(() => ({ operator: true }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  useCan: () => () => role.operator,
}));

const mapping = { columns: { name: 'name', serial: 'identity.serialNumber', owner: 'attribute.owner' }, defaultType: null, typeMap: {}, tagSeparator: ';' };
const preview = { headers: ['name', 'serial', 'owner'], mapping, rows: 3, accepted: 2, rejected: 1, rejectedRows: [{ row: 3, reason: 'no name' }], byType: { host: 2 }, sample: [['srv-1', 'SN-1', 'Treasury']] };
const job = { id: 'j1', filename: 'hosts.csv', format: 'csv', rows: 3, accepted: 2, rejected: 1, rejectedRows: [], byType: { host: 2 }, runId: 'r1', created: 2, submittedBy: 'admin', createdAt: '2026-11-05T10:00:00.000Z' };
const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
let jobs: unknown[] = [];

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  calls.push({ query: body.query, variables: body.variables ?? {} });
  // Like the API: the preview echoes the mapping it was given, or proposes one.
  if (body.query.includes('mutation PreviewImport(')) return { data: { previewImport: { ...preview, mapping: (body.variables?.['input'] as { mapping?: unknown } | undefined)?.mapping ?? mapping } } };
  if (body.query.includes('mutation RunImport(')) {
    jobs = [job];
    return { data: { runImport: job } };
  }
  if (body.query.includes('query ImportJobs')) return { data: { importJobs: jobs } };
  return { errors: [{ message: 'unexpected operation' }] };
}

beforeEach(() => {
  role.operator = true;
  jobs = [];
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

describe('import helpers', () => {
  it('derives column targets and the file format', () => {
    expect(targetsFor('Cost centre', ['host'])).toEqual(['ignore', 'name', 'type', 'tags', 'identity.serialNumber', 'identity.systemUuid', 'identity.fqdn', 'identity.primaryMac', 'attribute.costCentre']);
    expect(targetsFor('###', ['application'])).toEqual(['ignore', 'name', 'type', 'tags', 'identity.name']);
    expect(formatOf('Hosts.XLSX')).toBe('xlsx');
    expect(formatOf('hosts.csv')).toBe('csv');
  });
});

describe.each(LOCALES)('ImportView (%s)', (locale) => {
  it('previews a file, edits the mapping, checks again and imports', async () => {
    render(
      <Providers locale={locale}>
        <ImportView />
      </Providers>,
    );
    const file = new File(['name,serial,owner\nsrv-1,SN-1,Treasury\n'], 'hosts.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText(translate(locale, 'import.file')), { target: { files: [file] } });
    const summary = await screen.findByTestId('import-summary');
    expect(summary.textContent).toContain(translate(locale, 'import.summary', { rows: '3', accepted: '2', rejected: '1' }));
    const first = calls.find((c) => c.query.includes('PreviewImport'));
    expect(first?.variables['input']).toMatchObject({ filename: 'hosts.csv', format: 'csv', mapping: null });
    expect(typeof (first?.variables['input'] as { contentBase64: string }).contentBase64).toBe('string');
    expect(within(screen.getByTestId('import-rejected')).getByText(translate(locale, 'import.rejectedRow', { row: '3', reason: 'no name' }))).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: translate(locale, 'import.targetFor', { column: 'owner' }) }), { target: { value: 'ignore' } });
    fireEvent.change(screen.getByRole('combobox', { name: translate(locale, 'import.defaultType') }), { target: { value: 'host' } });
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'import.recheck') }));
    await waitFor(() => {
      expect(calls.filter((c) => c.query.includes('PreviewImport')).at(-1)?.variables['input']).toMatchObject({ mapping: { columns: { owner: 'ignore' }, defaultType: 'host' } });
    });
    fireEvent.click(await screen.findByRole('button', { name: translate(locale, 'import.run', { count: '2' }) }));
    await waitFor(() => {
      expect(calls.find((c) => c.query.includes('RunImport'))?.variables['input']).toMatchObject({ filename: 'hosts.csv', mapping: { defaultType: 'host' } });
    });
    const row = await screen.findByTestId('import-job');
    expect(within(row).getByTestId('import-job-created').textContent).toBe('2');
  });

  it('shows the jobs only to a non-operator', async () => {
    role.operator = false;
    jobs = [job];
    render(
      <Providers locale={locale}>
        <ImportView />
      </Providers>,
    );
    expect(screen.getByText(translate(locale, 'import.operatorsOnly'))).toBeTruthy();
    expect(await screen.findByTestId('import-job')).toBeTruthy();
    expect(screen.queryByLabelText(translate(locale, 'import.file'))).toBeNull();
  });
});
