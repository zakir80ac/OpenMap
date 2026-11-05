// T-167 REQ-CMDB-015 — custom fields in the console, en and ar: the CI detail lists the fields that apply to its type
// with their values; an operator edits them (a choice, a number, a cleared text) and only the change is sent, a bad
// number blocks the save; a type with no fields points to Settings. The Settings card lists the tenant's fields; an
// administrator adds a select field (key, both labels, options) and removes one after confirming; a non-administrator
// reads the list without controls.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';
import { Providers } from '@/providers';
import { CustomFieldsCard, inputOf } from '../settings/CustomFieldsCard';
import { CustomFieldsEditor, changeOf } from './CustomFieldsEditor';

const role = vi.hoisted(() => ({ admin: true, operator: true }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  useCan: () => (r: string) => (r === 'openmap-admin' ? role.admin : role.operator),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const defs = [
  { id: 'd1', key: 'businessOwner', labelEn: 'Business owner', labelAr: 'مالك الأعمال', description: '', type: 'text', options: [], appliesTo: [], required: false, usage: 3 },
  { id: 'd2', key: 'dataTier', labelEn: 'Data tier', labelAr: 'فئة البيانات', description: '', type: 'select', options: ['gold', 'silver'], appliesTo: ['host'], required: false, usage: 1 },
  { id: 'd3', key: 'rackUnits', labelEn: 'Rack units', labelAr: 'وحدات الرف', description: '', type: 'number', options: [], appliesTo: ['host'], required: false, usage: 0 },
] as const;

const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
let forType: readonly unknown[] = defs;

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  calls.push({ query: body.query, variables: body.variables ?? {} });
  if (body.query.includes('query CustomFieldDefinitions(')) return { data: { customFieldDefinitions: body.variables?.['type'] === null ? defs : forType } };
  if (body.query.includes('mutation SetCiCustomFields(')) return { data: { setCiCustomFields: { id: 'h1', customFields: {} } } };
  if (body.query.includes('mutation UpsertCustomFieldDefinition(')) return { data: { upsertCustomFieldDefinition: { ...defs[0], id: 'd9', key: 'costCode' } } };
  if (body.query.includes('mutation DeleteCustomFieldDefinition(')) return { data: { deleteCustomFieldDefinition: true } };
  return { errors: [{ message: 'unexpected operation' }] };
}

beforeEach(() => {
  role.admin = true;
  role.operator = true;
  forType = defs;
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

describe('custom field helpers', () => {
  it('sends only what changed and blocks a value that does not fit', () => {
    const list = defs as unknown as Parameters<typeof changeOf>[0];
    expect(changeOf(list, { businessOwner: 'Treasury', dataTier: 'gold' }, { businessOwner: 'Treasury', dataTier: 'silver', rackUnits: '2' })).toEqual({ change: { dataTier: 'silver', rackUnits: 2 }, errors: [] });
    expect(changeOf(list, { businessOwner: 'Treasury' }, { businessOwner: '', dataTier: '', rackUnits: 'two' })).toEqual({ change: { businessOwner: null }, errors: ['rackUnits'] });
    expect(inputOf({ id: null, key: 'costCode', labelEn: 'Cost code', labelAr: 'رمز التكلفة', description: '', type: 'select', options: 'a, b', appliesTo: [], required: false })).toMatchObject({ input: { key: 'costCode', options: ['a', 'b'] } });
    expect(inputOf({ id: null, key: 'Bad', labelEn: 'x', labelAr: 'x', description: '', type: 'text', options: '', appliesTo: [], required: false })).toEqual({ error: 'key' });
  });
});

describe.each(LOCALES)('custom fields (%s)', (locale) => {
  it('lists and edits the values on a CI', async () => {
    render(
      <Providers locale={locale}>
        <CustomFieldsEditor ci={{ id: 'h1', type: 'host', customFields: { businessOwner: 'Treasury', dataTier: 'gold' } }} />
      </Providers>,
    );
    const values = await screen.findByTestId('custom-field-values');
    expect(within(values).getByText(locale === 'ar' ? 'مالك الأعمال' : 'Business owner')).toBeTruthy();
    expect(within(values).getByText('Treasury')).toBeTruthy();
    expect(within(values).getByText(translate(locale, 'customFields.empty'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'customFields.editValues') }));
    const form = screen.getByRole('form', { name: translate(locale, 'customFields.valuesForm') });
    fireEvent.change(within(form).getByLabelText(locale === 'ar' ? 'فئة البيانات' : 'Data tier'), { target: { value: 'silver' } });
    fireEvent.change(within(form).getByLabelText(locale === 'ar' ? 'مالك الأعمال' : 'Business owner'), { target: { value: '' } });
    fireEvent.click(within(form).getByRole('button', { name: translate(locale, 'customFields.save') }));
    await waitFor(() => {
      expect(calls.find((c) => c.query.includes('SetCiCustomFields'))?.variables).toEqual({ ciId: 'h1', values: { dataTier: 'silver', businessOwner: null } });
    });
  });

  it('points to Settings when no field applies to the type', async () => {
    forType = [];
    render(
      <Providers locale={locale}>
        <CustomFieldsEditor ci={{ id: 'v1', type: 'vm', customFields: {} }} />
      </Providers>,
    );
    expect(await screen.findByText(translate(locale, 'customFields.noneForType'), { exact: false })).toBeTruthy();
    expect(screen.getByRole('link', { name: translate(locale, 'nav.settings') })).toBeTruthy();
  });

  it('lets an administrator add and remove a field in Settings', async () => {
    render(
      <Providers locale={locale}>
        <CustomFieldsCard />
      </Providers>,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('custom-field-row')).toHaveLength(3);
    });
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'customFields.add') }));
    const form = screen.getByRole('form', { name: translate(locale, 'customFields.form') });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'customFields.field.key')), { target: { value: 'costCode' } });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'customFields.field.type')), { target: { value: 'select' } });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'customFields.field.labelEn')), { target: { value: 'Cost code' } });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'customFields.field.labelAr')), { target: { value: 'رمز التكلفة' } });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'customFields.field.options')), { target: { value: 'CC-100, CC-200' } });
    fireEvent.click(within(form).getByRole('button', { name: translate(locale, 'customFields.save') }));
    await waitFor(() => {
      expect(calls.find((c) => c.query.includes('UpsertCustomFieldDefinition'))?.variables).toEqual({ id: null, input: { key: 'costCode', labelEn: 'Cost code', labelAr: 'رمز التكلفة', description: '', type: 'select', options: ['CC-100', 'CC-200'], appliesTo: [], required: false } });
    });
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'customFields.delete', { key: 'businessOwner' }) }));
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'customFields.confirmDelete', { count: '3' }) }));
    await waitFor(() => {
      expect(calls.find((c) => c.query.includes('DeleteCustomFieldDefinition'))?.variables).toEqual({ id: 'd1' });
    });
  });

  it('shows the list read-only to a non-administrator', async () => {
    role.admin = false;
    render(
      <Providers locale={locale}>
        <CustomFieldsCard />
      </Providers>,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('custom-field-row')).toHaveLength(3);
    });
    expect(screen.queryByRole('button')).toBeNull();
  });
});
