'use client';
// REQ-SEC-005 REQ-UI-003 REQ-UI-019 — Settings: the signed-in identity (user, tenant, roles), the tenant settings editor and the tenant's immutable audit
// log from `auditLog`, newest first, with an action filter and cursor paging. Auditors and administrators see the
// log; other roles see their session only, because the API refuses the query for them.
import { useInfiniteQuery } from '@tanstack/react-query';
import { ROLES } from '@openmap/constants';
import { Card, Pill, SectionTitle, Tag } from '@openmap/ui';
import { useMemo, useState, type ReactNode } from 'react';
import { QueryState } from '@/components/common/QueryState';
import { Icon } from '@/components/icons';
import { useAuth, useCan } from '@/lib/auth';
import { auditLogInfiniteQuery, type AuditEntry } from '@/lib/queries';
import { useFormatters, useT } from '@/providers';
import { CustomFieldsCard } from './CustomFieldsCard';
import { TenantSettingsCard } from './TenantSettingsCard';

/** Actions a mutation can carry, offered as the filter list; the server owns the truth, this is the display order. */
export const AUDIT_ACTIONS = ['labelCi', 'updateCiAttributes', 'createRelationship', 'retireRelationship', 'setLayerVisibility', 'runDiscovery', 'saveScenario', 'runSimulation', 'createPlan', 'setPlanStatus', 'setAssetStage', 'upsertIntegration', 'testIntegration', 'reportIncident', 'acknowledgeIncident', 'askAssistant', 'updateTenantSettings'] as const;

export function summariseDetails(details: Record<string, unknown>): string {
  const args = (details['arguments'] ?? details) as Record<string, unknown>;
  return Object.entries(args)
    .map(([key, value]) => key + '=' + (typeof value === 'string' ? value : JSON.stringify(value)))
    .join(' · ');
}

export function SettingsView(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const auth = useAuth();
  const can = useCan();
  const canAudit = can(ROLES.auditor);
  const [action, setAction] = useState<string>('');
  const audit = useInfiniteQuery({ ...auditLogInfiniteQuery({ action: action === '' ? null : action }), enabled: canAudit });
  const entries = useMemo<AuditEntry[]>(() => audit.data?.pages.flatMap((p) => p.edges.map((e) => e.node)) ?? [], [audit.data]);
  const total = audit.data?.pages[0]?.totalCount ?? 0;

  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle as="h1" size="lg" eyebrow={t('app.name')} description={t('settings.subtitle')}>
        {t('settings.title')}
      </SectionTitle>

      <Card padding="24" className="flex flex-col gap-om-16">
        <SectionTitle as="h2" size="sm" action={<Icon name="user" className="size-5 text-om-cyan" />}>
          {t('settings.identity.title')}
        </SectionTitle>
        <dl className="grid grid-cols-1 gap-om-12 md:grid-cols-3">
          <div className="flex flex-col gap-om-4">
            <dt className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('settings.identity.user')}</dt>
            <dd className="font-om-display text-om-sm font-semibold text-om-primary">{auth.user?.displayName ?? auth.user?.username ?? ''}</dd>
            <dd className="font-om-mono text-om-2xs text-om-muted">{auth.user?.email ?? auth.user?.username ?? ''}</dd>
          </div>
          <div className="flex flex-col gap-om-4">
            <dt className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('settings.identity.tenant')}</dt>
            <dd>
              <Tag>{auth.user?.tenant ?? ''}</Tag>
            </dd>
          </div>
          <div className="flex flex-col gap-om-4">
            <dt className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('settings.identity.roles')}</dt>
            <dd className="flex flex-wrap gap-om-6">
              {(auth.user?.roles ?? []).map((role) => (
                <Pill key={role}>{role}</Pill>
              ))}
            </dd>
          </div>
        </dl>
      </Card>

      <TenantSettingsCard />

      <CustomFieldsCard />

      {canAudit ? (
        <Card padding="24" className="flex flex-col gap-om-16">
          <SectionTitle
            as="h2"
            size="sm"
            description={t('settings.audit.subtitle')}
            action={
              <label className="flex items-center gap-om-8 text-om-xs text-om-secondary">
                <span>{t('settings.audit.filter.action')}</span>
                <select
                  value={action}
                  onChange={(event) => {
                    setAction(event.target.value);
                  }}
                  className="rounded-om-control border border-om-border-strong bg-om-surface3 px-om-8 py-om-4 text-om-xs text-om-primary"
                >
                  <option value="">{t('settings.audit.filter.all')}</option>
                  {AUDIT_ACTIONS.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            }
          >
            {t('settings.audit.title')}
          </SectionTitle>
          {audit.isPending ? (
            <QueryState status="pending" />
          ) : audit.isError ? (
            <QueryState
              status="error"
              onRetry={() => {
                void audit.refetch();
              }}
            />
          ) : entries.length === 0 ? (
            <p className="text-om-sm text-om-secondary">{t('settings.audit.empty')}</p>
          ) : (
            <>
              <p className="text-om-xs text-om-muted">{t('settings.audit.total', { count: format.integer(total) })}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-start text-om-xs">
                  <thead className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
                    <tr>
                      <th scope="col" className="py-om-6 pe-om-10 text-start">{t('settings.audit.when')}</th>
                      <th scope="col" className="py-om-6 pe-om-10 text-start">{t('settings.audit.actor')}</th>
                      <th scope="col" className="py-om-6 pe-om-10 text-start">{t('settings.audit.action')}</th>
                      <th scope="col" className="py-om-6 pe-om-10 text-start">{t('settings.audit.subject')}</th>
                      <th scope="col" className="py-om-6 text-start">{t('settings.audit.details')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => (
                      <tr key={entry.id} className="border-t border-om-border-glass align-top">
                        <td className="py-om-8 pe-om-10 whitespace-nowrap text-om-secondary">{format.dateTime(entry.at)}</td>
                        <td className="py-om-8 pe-om-10 font-om-mono text-om-primary">{entry.actor}</td>
                        <td className="py-om-8 pe-om-10">
                          <Tag>{entry.action}</Tag>
                        </td>
                        <td className="py-om-8 pe-om-10 font-om-mono text-om-secondary">{entry.subjectType + ' ' + entry.subjectId}</td>
                        <td className="py-om-8 font-om-mono text-om-2xs text-om-muted">{summariseDetails(entry.details)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {audit.hasNextPage ? (
                <button
                  type="button"
                  onClick={() => {
                    void audit.fetchNextPage();
                  }}
                  disabled={audit.isFetchingNextPage}
                  className="self-start rounded-om-control border border-om-cyan/30 bg-om-cyan/10 px-om-10 py-om-4 text-om-xs font-medium text-om-cyan transition-colors duration-om-base ease-om-standard hover:bg-om-cyan/20 disabled:opacity-60"
                >
                  {audit.isFetchingNextPage ? t('common.loading') : t('settings.audit.more')}
                </button>
              ) : null}
            </>
          )}
        </Card>
      ) : null}
    </div>
  );
}
