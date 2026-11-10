'use client';
// REQ-INT-016 (ADR-074) — Settings: identity sources, for administrators. Every directory (Active Directory, other LDAP)
// and OpenID Connect provider (Entra ID, Okta, other) the tenant's people sign in through: its state in Keycloak and the
// reason an apply failed, the OpenMap role each group grants, the last connection test and directory sync, and for a
// provider the redirect URI to register with it. Administrators add and edit a source (secrets as OpenBao refs only),
// test it (Keycloak's bind test or discovery read), sync a directory and remove a source after a confirmation.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IDENTITY_FEDERATION } from '@openmap/constants';
import {
  IDENTITY_MAPPED_ROLES,
  IDENTITY_SOURCE_VENDORS,
  identitySourceInputSchema,
  vendorKind,
  type IdentityMappedRole,
  type IdentitySourceInput,
  type IdentitySourceState,
  type IdentitySourceVendor,
} from '@openmap/contracts';
import { Card, SectionTitle, Tag, type UiState } from '@openmap/ui';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Button, Field, Select, TextInput, rowClass, tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import {
  identitySourcesQuery,
  identitySourcesQueryKey,
  removeIdentitySource,
  syncIdentitySource,
  testIdentitySource,
  upsertIdentitySource,
  type IdentitySourceView,
} from '@/lib/identity-source-queries';
import { useFormatters, useT } from '@/providers';

export interface MappingDraft {
  group: string;
  role: IdentityMappedRole;
}

export interface Draft {
  id: string | null;
  vendor: IdentitySourceVendor;
  name: string;
  enabled: boolean;
  secretRef: string;
  connectionUrl: string;
  startTls: boolean;
  bindDn: string;
  usersDn: string;
  userFilter: string;
  groupsDn: string;
  usernameAttribute: string;
  syncPeriodMinutes: string;
  issuer: string;
  directoryTenantId: string;
  domain: string;
  authorizationServerId: string;
  clientId: string;
  scopes: string;
  groupsClaim: string;
  roleMappings: MappingDraft[];
}

export const EMPTY_DRAFT: Draft = {
  id: null,
  vendor: 'active_directory',
  name: '',
  enabled: true,
  secretRef: '',
  connectionUrl: '',
  startTls: false,
  bindDn: '',
  usersDn: '',
  userFilter: '',
  groupsDn: '',
  usernameAttribute: '',
  syncPeriodMinutes: '',
  issuer: '',
  directoryTenantId: '',
  domain: '',
  authorizationServerId: '',
  clientId: '',
  scopes: '',
  groupsClaim: '',
  roleMappings: [{ group: '', role: 'analyst' }],
};

const STATE: Record<IdentitySourceState, UiState> = { applied: 'healthy', pending: 'unknown', error: 'down' };

export function draftOf(s: IdentitySourceView): Draft {
  return {
    ...EMPTY_DRAFT,
    id: s.id,
    vendor: s.vendor,
    name: s.name,
    enabled: s.enabled,
    secretRef: s.secretRef,
    connectionUrl: s.ldap?.connectionUrl ?? '',
    startTls: s.ldap?.startTls ?? false,
    bindDn: s.ldap?.bindDn ?? '',
    usersDn: s.ldap?.usersDn ?? '',
    userFilter: s.ldap?.userFilter ?? '',
    groupsDn: s.ldap?.groupsDn ?? '',
    usernameAttribute: s.ldap?.usernameAttribute ?? '',
    syncPeriodMinutes: s.ldap?.syncPeriodMinutes === null || s.ldap === null ? '' : String(s.ldap.syncPeriodMinutes),
    issuer: s.vendor === 'oidc' ? (s.oidc?.issuer ?? '') : '',
    directoryTenantId: s.oidc?.directoryTenantId ?? '',
    domain: s.oidc?.domain ?? '',
    authorizationServerId: s.oidc?.authorizationServerId ?? '',
    clientId: s.oidc?.clientId ?? '',
    scopes: s.oidc?.scopes ?? '',
    groupsClaim: s.oidc?.groupsClaim ?? '',
    roleMappings: s.roleMappings.map((m) => ({ ...m })),
  };
}

function optional(value: string): string | null {
  const v = value.trim();
  return v === '' ? null : v;
}

/** The draft as the GraphQL input, or the path of the first field that is not valid yet. */
export function inputOf(draft: Draft): { input: IdentitySourceInput } | { error: string } {
  const period = draft.syncPeriodMinutes.trim();
  const mappings = draft.roleMappings.filter((m) => m.group.trim() !== '').map((m) => ({ group: m.group.trim(), role: m.role }));
  const base = { vendor: draft.vendor, name: draft.name.trim(), enabled: draft.enabled, secretRef: draft.secretRef.trim(), roleMappings: mappings };
  const input: IdentitySourceInput =
    vendorKind(draft.vendor) === 'ldap'
      ? {
          ...base,
          ldap: {
            connectionUrl: draft.connectionUrl.trim(),
            startTls: draft.startTls,
            bindDn: draft.bindDn.trim(),
            usersDn: draft.usersDn.trim(),
            userFilter: optional(draft.userFilter),
            groupsDn: draft.groupsDn.trim(),
            usernameAttribute: optional(draft.usernameAttribute),
            syncPeriodMinutes: period === '' ? null : Number(period),
          },
        }
      : {
          ...base,
          oidc: {
            issuer: draft.vendor === 'oidc' ? optional(draft.issuer) : null,
            directoryTenantId: draft.vendor === 'entra_id' ? optional(draft.directoryTenantId) : null,
            domain: draft.vendor === 'okta' ? optional(draft.domain) : null,
            authorizationServerId: draft.vendor === 'okta' ? optional(draft.authorizationServerId) : null,
            clientId: draft.clientId.trim(),
            scopes: optional(draft.scopes),
            groupsClaim: optional(draft.groupsClaim),
          },
        };
  const parsed = identitySourceInputSchema.safeParse(input);
  return parsed.success ? { input } : { error: parsed.error.issues[0]?.path.join('.') ?? 'input' };
}

/** The draft fields edited as text. */
type TextKey = { [K in keyof Draft]: Draft[K] extends string ? K : never }[keyof Draft];

interface TextFieldSpec {
  key: TextKey;
  label: string;
  hint?: string;
  mono?: boolean;
}

export function IdentitySourcesCard(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const formId = useId();
  const queryClient = useQueryClient();
  const sources = useQuery(identitySourcesQuery());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: identitySourcesQueryKey });
  const save = useMutation({
    mutationFn: ({ id, input }: { id: string | null; input: IdentitySourceInput }) => upsertIdentitySource(id, input),
    onSuccess: async () => {
      setDraft(null);
      await refresh();
    },
  });
  const test = useMutation({ mutationFn: (id: string) => testIdentitySource(id), onSettled: refresh });
  const sync = useMutation({ mutationFn: (id: string) => syncIdentitySource(id), onSettled: refresh });
  const remove = useMutation({
    mutationFn: (id: string) => removeIdentitySource(id),
    onSuccess: async () => {
      setConfirming(null);
      await refresh();
    },
  });
  const checked = draft === null ? null : inputOf(draft);
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (draft === null || checked === null || 'error' in checked) return;
    save.mutate({ id: draft.id, input: checked.input });
  };
  const list = sources.data ?? [];
  const busy = test.isPending || sync.isPending;
  const failure = [test, sync, remove].find((m) => m.isError)?.error;

  const textField = (spec: TextFieldSpec): ReactNode =>
    draft === null ? null : (
      <Field key={spec.key} id={formId + '-' + spec.key} label={spec.label} hint={spec.hint}>
        <TextInput
          id={formId + '-' + spec.key}
          dir={spec.mono === true ? 'ltr' : undefined}
          className={spec.mono === true ? 'font-om-mono' : undefined}
          value={draft[spec.key]}
          onChange={(e) => {
            setDraft({ ...draft, [spec.key]: e.target.value });
          }}
        />
      </Field>
    );

  return (
    <Card as="section" padding="24" className="flex flex-col gap-om-16">
      <SectionTitle
        as="h2"
        size="sm"
        description={t('identitySources.subtitle')}
        action={
          draft === null ? (
            <Button
              onClick={() => {
                save.reset();
                setDraft(EMPTY_DRAFT);
              }}
            >
              {t('identitySources.add')}
            </Button>
          ) : null
        }
      >
        {t('identitySources.title')}
      </SectionTitle>

      {sources.isPending ? <QueryState status="pending" /> : null}
      {sources.isError ? <QueryState status="error" onRetry={() => void sources.refetch()} /> : null}
      {sources.isSuccess && list.length === 0 ? <p className="text-om-sm text-om-secondary">{t('identitySources.none')}</p> : null}
      {list.length > 0 ? (
        <div className="overflow-x-auto">
          <table className={tableClass} aria-label={t('identitySources.title')}>
            <thead className={theadClass}>
              <tr>
                <th scope="col" className={thClass}>{t('identitySources.col.source')}</th>
                <th scope="col" className={thClass}>{t('identitySources.col.state')}</th>
                <th scope="col" className={thClass}>{t('identitySources.col.roles')}</th>
                <th scope="col" className={thClass}>{t('identitySources.col.checks')}</th>
                <th scope="col" className={thClass}><span className="sr-only">{t('identitySources.col.actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id} className={rowClass} data-testid="identity-source-row" data-state={s.state}>
                  <td className={tdClass}>
                    <span className="block text-om-sm text-om-primary"><bdi>{s.name}</bdi></span>
                    <span className="flex flex-wrap items-center gap-om-6">
                      <Tag>{t(`identitySources.vendor.${s.vendor}`)}</Tag>
                      {s.enabled ? null : <Tag>{t('identitySources.disabled')}</Tag>}
                      <bdi className="font-om-mono text-om-2xs text-om-muted">{s.alias}</bdi>
                    </span>
                    {s.oidc !== null ? (
                      <span className="mt-om-4 block text-om-2xs text-om-muted">
                        {t('identitySources.redirectUri')}{' '}
                        <bdi className="font-om-mono text-om-secondary" data-testid="identity-redirect-uri">{s.oidc.redirectUri}</bdi>
                      </span>
                    ) : null}
                  </td>
                  <td className={tdClass}>
                    <Tag variant="state" state={STATE[s.state]}>{t(`identitySources.state.${s.state}`)}</Tag>
                    {s.lastError !== null ? <span className="block text-om-2xs text-om-rose">{s.lastError}</span> : null}
                  </td>
                  <td className={tdClass + ' text-om-2xs'}>
                    {s.roleMappings.length === 0 ? (
                      <span className="text-om-muted">{t('identitySources.noMappings')}</span>
                    ) : (
                      <ul className="flex flex-col gap-om-4">
                        {s.roleMappings.map((m) => (
                          <li key={m.group + '|' + m.role}>
                            {t('identitySources.mapping', { group: m.group, role: t(`identitySources.role.${m.role}`) })}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className={tdClass + ' text-om-2xs'}>
                    {s.lastTest === null ? (
                      <span className="text-om-muted">{t('identitySources.notTested')}</span>
                    ) : (
                      <span className="block" data-testid="identity-test-result" data-ok={s.lastTest.ok ? 'true' : 'false'}>
                        <Tag variant="state" state={s.lastTest.ok ? 'healthy' : 'down'}>
                          {s.lastTest.ok ? t('identitySources.testOk') : t('identitySources.testFailed')}
                        </Tag>{' '}
                        <span className="text-om-muted">{format.dateTime(s.lastTest.at)}</span>
                        <span className="block text-om-secondary">{s.lastTest.message}</span>
                      </span>
                    )}
                    {s.lastSync !== null ? (
                      <span className="mt-om-4 block text-om-secondary" data-testid="identity-sync-result">
                        {t('identitySources.syncSummary', {
                          added: format.integer(s.lastSync.added),
                          updated: format.integer(s.lastSync.updated),
                          removed: format.integer(s.lastSync.removed),
                          failed: format.integer(s.lastSync.failed),
                          groups: format.integer(s.lastSync.groups),
                          at: format.dateTime(s.lastSync.at),
                        })}
                      </span>
                    ) : null}
                  </td>
                  <td className={tdClass}>
                    <span className="flex flex-wrap gap-om-6">
                      <Button tone="quiet" aria-label={t('identitySources.edit', { name: s.name })} onClick={() => { save.reset(); setDraft(draftOf(s)); }}>
                        {t('identitySources.editShort')}
                      </Button>
                      <Button tone="quiet" disabled={busy} aria-label={t('identitySources.test', { name: s.name })} onClick={() => { test.mutate(s.id); }}>
                        {t('identitySources.testShort')}
                      </Button>
                      {s.kind === 'ldap' ? (
                        <Button tone="quiet" disabled={busy || s.state !== 'applied'} aria-label={t('identitySources.sync', { name: s.name })} onClick={() => { sync.mutate(s.id); }}>
                          {t('identitySources.syncShort')}
                        </Button>
                      ) : null}
                      {confirming === s.id ? (
                        <Button tone="danger" disabled={remove.isPending} onClick={() => { remove.mutate(s.id); }}>
                          {t('identitySources.confirmRemove')}
                        </Button>
                      ) : (
                        <Button tone="quiet" aria-label={t('identitySources.remove', { name: s.name })} onClick={() => { setConfirming(s.id); }}>
                          {t('identitySources.removeShort')}
                        </Button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {busy ? <p className="text-om-2xs text-om-muted">{t('identitySources.working')}</p> : null}
      {failure !== undefined ? (
        <p role="alert" className="text-om-2xs text-om-rose">
          {failure.message === '' ? t('identitySources.failed') : failure.message}
        </p>
      ) : null}

      {draft !== null ? (
        <form onSubmit={onSubmit} aria-label={t('identitySources.form')} className="grid gap-om-12 rounded-om-panel border border-om-border-glass p-om-12 md:grid-cols-2">
          <Field id={formId + '-vendor'} label={t('identitySources.field.vendor')}>
            <Select
              id={formId + '-vendor'}
              value={draft.vendor}
              disabled={draft.id !== null}
              onChange={(e) => {
                setDraft({ ...draft, vendor: e.target.value as IdentitySourceVendor });
              }}
            >
              {IDENTITY_SOURCE_VENDORS.map((v) => (
                <option key={v} value={v}>
                  {t(`identitySources.vendor.${v}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={formId + '-name'} label={t('identitySources.field.name')}>
            <TextInput
              id={formId + '-name'}
              value={draft.name}
              maxLength={IDENTITY_FEDERATION.maxNameLength}
              onChange={(e) => {
                setDraft({ ...draft, name: e.target.value });
              }}
            />
          </Field>
          {textField({ key: 'secretRef', label: t('identitySources.field.secretRef'), hint: t(vendorKind(draft.vendor) === 'ldap' ? 'identitySources.field.secretRefLdapHint' : 'identitySources.field.secretRefOidcHint'), mono: true })}
          <label className="flex items-center gap-om-8 text-om-sm text-om-secondary">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => {
                setDraft({ ...draft, enabled: e.target.checked });
              }}
            />
            {t('identitySources.field.enabled')}
          </label>

          {vendorKind(draft.vendor) === 'ldap' ? (
            <>
              {textField({ key: 'connectionUrl', label: t('identitySources.field.connectionUrl'), hint: t('identitySources.field.connectionUrlHint'), mono: true })}
              <label className="flex items-center gap-om-8 text-om-sm text-om-secondary">
                <input
                  type="checkbox"
                  checked={draft.startTls}
                  onChange={(e) => {
                    setDraft({ ...draft, startTls: e.target.checked });
                  }}
                />
                {t('identitySources.field.startTls')}
              </label>
              {textField({ key: 'bindDn', label: t('identitySources.field.bindDn'), mono: true })}
              {textField({ key: 'usersDn', label: t('identitySources.field.usersDn'), mono: true })}
              {textField({ key: 'groupsDn', label: t('identitySources.field.groupsDn'), mono: true })}
              {textField({ key: 'userFilter', label: t('identitySources.field.userFilter'), hint: t('identitySources.field.optional'), mono: true })}
              {textField({ key: 'usernameAttribute', label: t('identitySources.field.usernameAttribute'), hint: t('identitySources.field.usernameAttributeHint'), mono: true })}
              {textField({ key: 'syncPeriodMinutes', label: t('identitySources.field.syncPeriod'), hint: t('identitySources.field.syncPeriodHint', { min: format.integer(IDENTITY_FEDERATION.minSyncPeriodMinutes) }) })}
            </>
          ) : (
            <>
              {draft.vendor === 'entra_id' ? textField({ key: 'directoryTenantId', label: t('identitySources.field.directoryTenantId'), hint: t('identitySources.field.directoryTenantIdHint'), mono: true }) : null}
              {draft.vendor === 'okta' ? textField({ key: 'domain', label: t('identitySources.field.domain'), mono: true }) : null}
              {draft.vendor === 'okta' ? textField({ key: 'authorizationServerId', label: t('identitySources.field.authorizationServerId'), hint: t('identitySources.field.authorizationServerIdHint'), mono: true }) : null}
              {draft.vendor === 'oidc' ? textField({ key: 'issuer', label: t('identitySources.field.issuer'), mono: true }) : null}
              {textField({ key: 'clientId', label: t('identitySources.field.clientId'), mono: true })}
              {textField({ key: 'scopes', label: t('identitySources.field.scopes'), hint: t('identitySources.field.presetHint'), mono: true })}
              {textField({ key: 'groupsClaim', label: t('identitySources.field.groupsClaim'), hint: t('identitySources.field.presetHint'), mono: true })}
            </>
          )}

          <fieldset className="flex flex-col gap-om-8 md:col-span-2">
            <legend className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('identitySources.field.mappings')}</legend>
            <p className="text-om-2xs text-om-muted">{t(vendorKind(draft.vendor) === 'ldap' ? 'identitySources.field.mappingsLdapHint' : 'identitySources.field.mappingsOidcHint')}</p>
            {draft.roleMappings.map((m, i) => (
              <div key={i} className="flex flex-wrap items-end gap-om-8" data-testid="identity-mapping">
                <Field id={formId + '-group-' + String(i)} label={t('identitySources.field.group')} className="min-w-0 flex-1">
                  <TextInput
                    id={formId + '-group-' + String(i)}
                    value={m.group}
                    maxLength={IDENTITY_FEDERATION.maxGroupLength}
                    onChange={(e) => {
                      setDraft({ ...draft, roleMappings: draft.roleMappings.map((x, j) => (j === i ? { ...x, group: e.target.value } : x)) });
                    }}
                  />
                </Field>
                <Field id={formId + '-role-' + String(i)} label={t('identitySources.field.role')}>
                  <Select
                    id={formId + '-role-' + String(i)}
                    value={m.role}
                    onChange={(e) => {
                      setDraft({ ...draft, roleMappings: draft.roleMappings.map((x, j) => (j === i ? { ...x, role: e.target.value as IdentityMappedRole } : x)) });
                    }}
                  >
                    {IDENTITY_MAPPED_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(`identitySources.role.${r}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button
                  tone="quiet"
                  aria-label={t('identitySources.removeMapping', { index: format.integer(i + 1) })}
                  onClick={() => {
                    setDraft({ ...draft, roleMappings: draft.roleMappings.filter((_, j) => j !== i) });
                  }}
                >
                  {t('identitySources.removeMappingShort')}
                </Button>
              </div>
            ))}
            <Button
              tone="quiet"
              className="self-start"
              disabled={draft.roleMappings.length >= IDENTITY_FEDERATION.maxRoleMappings}
              onClick={() => {
                setDraft({ ...draft, roleMappings: [...draft.roleMappings, { group: '', role: 'analyst' }] });
              }}
            >
              {t('identitySources.addMapping')}
            </Button>
          </fieldset>

          <div className="flex flex-wrap items-center gap-om-8 md:col-span-2">
            <Button type="submit" disabled={checked === null || 'error' in checked || save.isPending}>
              {save.isPending ? t('identitySources.applying') : t('identitySources.save')}
            </Button>
            <Button
              tone="quiet"
              onClick={() => {
                setDraft(null);
              }}
            >
              {t('identitySources.cancel')}
            </Button>
            {checked !== null && 'error' in checked ? <span className="text-om-2xs text-om-amber">{t('identitySources.invalid', { field: checked.error })}</span> : null}
            {save.isError ? (
              <span role="alert" className="text-om-2xs text-om-rose">
                {save.error instanceof Error ? save.error.message : t('identitySources.failed')}
              </span>
            ) : null}
          </div>
        </form>
      ) : null}
    </Card>
  );
}
