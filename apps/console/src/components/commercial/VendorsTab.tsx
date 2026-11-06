'use client';
// REQ-CMDB-027 (ADR-035) — vendors: each vendor CI with its category, support portal, account manager, active and total
// contracts, covered assets, annual cost and contacts; a vendor opens its escalation path (contacts by level, with how
// and when to reach them) and its contracts. Operators add and edit vendors and their contacts.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { COMMERCIAL } from '@openmap/constants';
import { Card, SectionTitle, Tag } from '@openmap/ui';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import {
  Button,
  Field,
  TextInput,
  rowClass,
  tableClass,
  tdClass,
  thClass,
  theadClass,
} from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import {
  deleteVendorContact,
  upsertVendor,
  upsertVendorContact,
  vendorQuery,
  vendorsQuery,
  type Vendor,
  type VendorContact,
  type VendorContactInput,
  type VendorInput,
} from '@/lib/commercial-queries';
import { useFormatters, useT } from '@/providers';
import { isLink, kindKey } from './ContractsTab';
import { moneyText, textOrNull } from './format';

function VendorForm({ vendor, onDone }: { vendor: Vendor | null; onDone: () => void }): ReactNode {
  const t = useT();
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState(vendor?.ci.displayName ?? '');
  const [category, setCategory] = useState(vendor?.category ?? '');
  const [portal, setPortal] = useState(vendor?.supportPortal ?? '');
  const [manager, setManager] = useState(vendor?.accountManager ?? '');
  const mutation = useMutation({
    mutationFn: (input: VendorInput) => upsertVendor(vendor?.ci.id ?? null, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['vendors'] });
      await queryClient.invalidateQueries({ queryKey: ['vendor'] });
      onDone();
    },
  });
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (name.trim() === '') return;
    mutation.mutate({ name: name.trim(), category: textOrNull(category), supportPortal: textOrNull(portal), accountManager: textOrNull(manager) });
  };
  const title = vendor === null ? t('commercial.vendor.new') : t('commercial.vendor.edit', { name: vendor.ci.displayName });
  return (
    <form onSubmit={onSubmit} aria-label={title} className="flex flex-col gap-om-12 rounded-om-panel border border-dashed border-om-border-strong p-om-16">
      <h3 className="font-om-display text-om-sm font-semibold text-om-primary">{title}</h3>
      <div className="grid grid-cols-1 gap-om-12 md:grid-cols-4">
        <Field id={id + '-name'} label={t('commercial.vendor.name')}>
          <TextInput
            id={id + '-name'}
            value={name}
            required
            disabled={vendor !== null}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>
        <Field id={id + '-category'} label={t('commercial.vendor.category')}>
          <TextInput
            id={id + '-category'}
            value={category}
            onChange={(event) => {
              setCategory(event.target.value);
            }}
          />
        </Field>
        <Field id={id + '-portal'} label={t('commercial.vendor.portal')}>
          <TextInput
            id={id + '-portal'}
            value={portal}
            onChange={(event) => {
              setPortal(event.target.value);
            }}
          />
        </Field>
        <Field id={id + '-manager'} label={t('commercial.vendor.accountManager')}>
          <TextInput
            id={id + '-manager'}
            value={manager}
            onChange={(event) => {
              setManager(event.target.value);
            }}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-om-10">
        <Button type="submit" disabled={name.trim() === '' || mutation.isPending}>
          {t('common.save')}
        </Button>
        <Button tone="quiet" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        {mutation.isError ? (
          <span role="alert" className="text-om-xs text-om-state-down">
            {mutation.error instanceof Error ? mutation.error.message : t('commercial.saveError')}
          </span>
        ) : null}
      </div>
    </form>
  );
}

interface ContactDraft {
  name: string;
  role: string;
  email: string;
  phone: string;
  portalUrl: string;
  availability: string;
  escalationLevel: string;
}

function contactDraft(contact: VendorContact | null): ContactDraft {
  return {
    name: contact?.name ?? '',
    role: contact?.role ?? '',
    email: contact?.email ?? '',
    phone: contact?.phone ?? '',
    portalUrl: contact?.portalUrl ?? '',
    availability: contact?.availability ?? '',
    escalationLevel: String(contact?.escalationLevel ?? COMMERCIAL.defaultEscalationLevel),
  };
}

/** The contact form as the mutation's input, or null while the name, role or level is missing or out of range. */
export function toContactInput(vendorId: string, d: ContactDraft, id: string | null): VendorContactInput | null {
  const level = Number(d.escalationLevel);
  if (d.name.trim() === '' || d.role.trim() === '' || !Number.isInteger(level)) return null;
  if (level < COMMERCIAL.defaultEscalationLevel || level > COMMERCIAL.maxEscalationLevel) return null;
  const input: VendorContactInput = {
    vendorId,
    name: d.name.trim(),
    role: d.role.trim(),
    email: textOrNull(d.email),
    phone: textOrNull(d.phone),
    portalUrl: textOrNull(d.portalUrl),
    availability: textOrNull(d.availability),
    escalationLevel: level,
  };
  if (id !== null) input.id = id;
  return input;
}

function ContactForm({ vendorId, contact, onDone }: { vendorId: string; contact: VendorContact | null; onDone: () => void }): ReactNode {
  const t = useT();
  const id = useId();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => contactDraft(contact));
  const input = toContactInput(vendorId, draft, contact?.id ?? null);
  const mutation = useMutation({
    mutationFn: upsertVendorContact,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['vendor', vendorId] });
      await queryClient.invalidateQueries({ queryKey: ['vendors'] });
      onDone();
    },
  });
  const field = (key: keyof ContactDraft, label: Parameters<typeof t>[0], type = 'text'): ReactNode => (
    <Field id={id + '-' + key} label={t(label)}>
      <TextInput
        id={id + '-' + key}
        type={type}
        value={draft[key]}
        onChange={(event) => {
          setDraft((current) => ({ ...current, [key]: event.target.value }));
        }}
      />
    </Field>
  );
  const title = contact === null ? t('commercial.contact.new') : t('commercial.contact.edit', { name: contact.name });
  return (
    <form
      aria-label={title}
      onSubmit={(event) => {
        event.preventDefault();
        if (input !== null) mutation.mutate(input);
      }}
      className="flex flex-col gap-om-10 rounded-om-panel border border-dashed border-om-border-strong p-om-12"
    >
      <div className="grid grid-cols-1 gap-om-10 md:grid-cols-4">
        {field('name', 'commercial.contact.name')}
        {field('role', 'commercial.contact.role')}
        {field('email', 'commercial.contact.email', 'email')}
        {field('phone', 'commercial.contact.phone', 'tel')}
        {field('portalUrl', 'commercial.contact.portal')}
        {field('availability', 'commercial.contact.availability')}
        {field('escalationLevel', 'commercial.contact.level', 'number')}
      </div>
      <div className="flex flex-wrap items-center gap-om-10">
        <Button type="submit" disabled={input === null || mutation.isPending}>
          {t('common.save')}
        </Button>
        <Button tone="quiet" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        {mutation.isError ? (
          <span role="alert" className="text-om-xs text-om-state-down">
            {mutation.error instanceof Error ? mutation.error.message : t('commercial.saveError')}
          </span>
        ) : null}
      </div>
    </form>
  );
}

function VendorDetailPanel({ vendorId, canOperate, onClose }: { vendorId: string; canOperate: boolean; onClose: () => void }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const queryClient = useQueryClient();
  const detail = useQuery(vendorQuery(vendorId));
  const [contactEdit, setContactEdit] = useState<VendorContact | 'new' | null>(null);
  const remove = useMutation({
    mutationFn: deleteVendorContact,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['vendor', vendorId] });
      await queryClient.invalidateQueries({ queryKey: ['vendors'] });
    },
  });
  if (detail.isPending) return <QueryState status="pending" />;
  if (detail.isError || detail.data === null)
    return (
      <QueryState
        status="error"
        onRetry={() => {
          void detail.refetch();
        }}
      />
    );
  const { vendor, contacts, contracts } = detail.data;
  return (
    <section aria-label={t('commercial.vendor.detail', { name: vendor.ci.displayName })} data-testid="vendor-detail" className="flex flex-col gap-om-12 rounded-om-panel border border-om-border-glass bg-om-surface2 p-om-16">
      <div className="flex flex-wrap items-center gap-om-10">
        <h3 className="font-om-display text-om-md font-semibold text-om-primary">{vendor.ci.displayName}</h3>
        {vendor.category !== null ? <Tag>{vendor.category}</Tag> : null}
        {vendor.supportPortal !== null ? (
          isLink(vendor.supportPortal) ? (
            <a href={vendor.supportPortal} target="_blank" rel="noreferrer" className="text-om-xs text-om-cyan hover:underline">
              {t('commercial.vendor.portal')}
            </a>
          ) : (
            <span className="text-om-xs text-om-secondary">{vendor.supportPortal}</span>
          )
        ) : null}
        <Button tone="quiet" className="ms-auto" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>
      <div className="flex flex-col gap-om-6">
        <div className="flex items-center gap-om-10">
          <h4 className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('commercial.contact.escalation')}</h4>
          {canOperate && contactEdit === null ? (
            <Button
              tone="quiet"
              onClick={() => {
                setContactEdit('new');
              }}
            >
              {t('commercial.contact.new')}
            </Button>
          ) : null}
        </div>
        {contactEdit !== null ? (
          <ContactForm
            vendorId={vendorId}
            contact={contactEdit === 'new' ? null : contactEdit}
            onDone={() => {
              setContactEdit(null);
            }}
          />
        ) : null}
        {contacts.length === 0 ? (
          <p className="text-om-xs text-om-secondary">{t('commercial.contact.empty')}</p>
        ) : (
          <ol className="flex flex-col gap-om-6" data-testid="vendor-contacts">
            {contacts.map((c) => (
              <li key={c.id} className="flex flex-wrap items-baseline gap-om-8 text-om-xs">
                <Tag>{t('commercial.contact.levelN', { level: format.integer(c.escalationLevel) })}</Tag>
                <span className="font-semibold text-om-primary">{c.name}</span>
                <span className="text-om-secondary">{c.role}</span>
                {c.email !== null ? <a href={'mailto:' + c.email} className="text-om-cyan hover:underline">{c.email}</a> : null}
                {c.phone !== null ? <span className="font-om-mono text-om-secondary">{c.phone}</span> : null}
                {c.availability !== null ? <span className="text-om-muted">{c.availability}</span> : null}
                {canOperate ? (
                  <span className="ms-auto flex gap-om-6">
                    <Button
                      tone="quiet"
                      aria-label={t('commercial.contact.edit', { name: c.name })}
                      onClick={() => {
                        setContactEdit(c);
                      }}
                    >
                      {t('commercial.edit')}
                    </Button>
                    <Button
                      tone="danger"
                      aria-label={t('commercial.contact.remove', { name: c.name })}
                      disabled={remove.isPending}
                      onClick={() => {
                        remove.mutate(c.id);
                      }}
                    >
                      {t('commercial.remove')}
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="flex flex-col gap-om-6">
        <h4 className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('commercial.contracts.title')}</h4>
        {contracts.length === 0 ? (
          <p className="text-om-xs text-om-secondary">{t('commercial.contracts.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-om-4 text-om-xs">
            {contracts.map((c) => (
              <li key={c.ci.id} className="flex flex-wrap items-baseline gap-om-8">
                <span className="text-om-primary">{c.title}</span>
                <span className="font-om-mono text-om-2xs text-om-muted">{c.contractNumber}</span>
                <Tag>{t(kindKey(c.kind))}</Tag>
                {c.endsAt !== null ? <span className="text-om-secondary">{format.date(c.endsAt)}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function VendorsTab({ canOperate }: { canOperate: boolean }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Vendor | 'new' | null>(null);
  const vendors = useQuery(vendorsQuery(text.trim() === '' ? null : text.trim()));
  const list = vendors.data ?? [];
  return (
    <Card padding="24" className="flex flex-col gap-om-16" as="section">
      <SectionTitle
        as="h2"
        size="sm"
        description={t('commercial.vendors.subtitle')}
        action={
          canOperate && editing === null ? (
            <Button
              onClick={() => {
                setEditing('new');
              }}
            >
              {t('commercial.vendor.new')}
            </Button>
          ) : null
        }
      >
        {t('commercial.vendors.title')}
      </SectionTitle>
      {editing !== null ? (
        <VendorForm
          key={editing === 'new' ? 'new' : editing.ci.id}
          vendor={editing === 'new' ? null : editing}
          onDone={() => {
            setEditing(null);
          }}
        />
      ) : null}
      {selected !== null ? (
        <VendorDetailPanel
          vendorId={selected}
          canOperate={canOperate}
          onClose={() => {
            setSelected(null);
          }}
        />
      ) : null}
      <Field id={id + '-text'} label={t('commercial.filter.vendors')}>
        <TextInput
          id={id + '-text'}
          type="search"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
      </Field>
      {vendors.isPending ? (
        <QueryState status="pending" />
      ) : vendors.isError ? (
        <QueryState
          status="error"
          onRetry={() => {
            void vendors.refetch();
          }}
        />
      ) : list.length === 0 ? (
        <p className="text-om-sm text-om-secondary">{t('commercial.vendors.empty')}</p>
      ) : (
        <div className="overflow-x-auto" data-testid="vendor-register">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th scope="col" className={thClass}>
                  {t('commercial.vendor.name')}
                </th>
                <th scope="col" className={thClass}>
                  {t('commercial.vendor.accountManager')}
                </th>
                <th scope="col" className={thClass}>
                  {t('commercial.vendor.contracts')}
                </th>
                <th scope="col" className={thClass}>
                  {t('commercial.contract.covered')}
                </th>
                <th scope="col" className={thClass}>
                  {t('commercial.contract.annualCost')}
                </th>
                <th scope="col" className={thClass}>
                  {t('commercial.vendor.contacts')}
                </th>
                <th scope="col" className={thClass}>
                  <span className="sr-only">{t('commercial.open')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((v) => (
                <tr key={v.ci.id} className={rowClass} data-vendor={v.ci.displayName}>
                  <td className={tdClass + ' text-om-primary'}>
                    {v.ci.displayName}
                    {v.category !== null ? <span className="block text-om-2xs text-om-muted">{v.category}</span> : null}
                  </td>
                  <td className={tdClass + ' text-om-secondary'}>{v.accountManager ?? t('common.none')}</td>
                  <td className={tdClass + ' font-om-mono text-om-secondary'}>
                    {t('commercial.vendor.activeOf', { active: format.integer(v.activeContracts), total: format.integer(v.contracts) })}
                  </td>
                  <td className={tdClass + ' font-om-mono text-om-secondary'}>{format.integer(v.coveredAssets)}</td>
                  <td className={tdClass + ' font-om-mono text-om-secondary'}>{moneyText(format, v.annualCost) || t('common.none')}</td>
                  <td className={tdClass + ' font-om-mono text-om-secondary'}>{format.integer(v.contacts)}</td>
                  <td className={tdClass + ' text-end'}>
                    <span className="flex justify-end gap-om-6">
                      <Button
                        tone="quiet"
                        aria-label={t('commercial.vendor.open', { name: v.ci.displayName })}
                        aria-pressed={selected === v.ci.id}
                        onClick={() => {
                          setSelected(selected === v.ci.id ? null : v.ci.id);
                        }}
                      >
                        {t('commercial.open')}
                      </Button>
                      {canOperate ? (
                        <Button
                          tone="quiet"
                          aria-label={t('commercial.vendor.edit', { name: v.ci.displayName })}
                          onClick={() => {
                            setEditing(v);
                          }}
                        >
                          {t('commercial.edit')}
                        </Button>
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
