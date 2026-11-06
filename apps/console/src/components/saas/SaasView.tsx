'use client';
// REQ-CMDB-022 — SaaS: every SaaS tenant discovery reads (Microsoft 365, Google Workspace, Salesforce, ServiceNow,
// Workday…) with users, active users, SSO applications and domains; each subscription with seats bought and assigned,
// unused seats and underuse (a true-down candidate), the renewal date and whether it is renewing soon or has lapsed;
// and the organisation's applications that exchange data with each product, with the data class.
import { useQuery } from '@tanstack/react-query';
import { SAAS } from '@openmap/constants';
import type { Locale, MessageKey } from '@openmap/i18n';
import { Bar, Card, Kpi, SectionTitle, StateBadge, Tag, accents } from '@openmap/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { rowClass, tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { localizedHref } from '@/lib/locale-path';
import { saasInventoryQuery, type SaasSubscriptionState } from '@/lib/saas-queries';
import { useFormatters, useT } from '@/providers';

const BADGE: Record<SaasSubscriptionState, 'healthy' | 'at_risk' | 'down' | 'unknown'> = {
  active: 'healthy',
  renewing: 'at_risk',
  lapsed: 'down',
  unknown: 'unknown',
};

export function SaasView({ locale }: { locale: Locale }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const q = useQuery(saasInventoryQuery());
  const href = (id: string): string => localizedHref(locale, '/cmdb/' + encodeURIComponent(id));
  const none = t('common.none');
  const data = q.data;
  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle
        as="h1"
        size="lg"
        eyebrow={t('app.name')}
        description={t('saas.subtitle', {
          days: format.integer(SAAS.renewalHorizonDays),
          percent: format.integer(SAAS.underusedPercent),
        })}
      >
        {t('saas.title')}
      </SectionTitle>
      <div className="grid grid-cols-2 gap-om-12 md:grid-cols-6">
        <Kpi
          label={t('saas.kpi.tenants')}
          value={data === undefined ? none : format.integer(data.tenants.length)}
        />
        <Kpi
          label={t('saas.kpi.seats')}
          value={data === undefined ? none : format.integer(data.seatsTotal)}
        />
        <Kpi
          label={t('saas.kpi.assigned')}
          value={data === undefined ? none : format.integer(data.seatsAssigned)}
        />
        <Kpi
          label={t('saas.kpi.unused')}
          value={data === undefined ? none : format.integer(data.unusedSeats)}
          lowerIsBetter
        />
        <Kpi
          label={t('saas.kpi.renewing')}
          value={data === undefined ? none : format.integer(data.renewing)}
          lowerIsBetter
        />
        <Kpi
          label={t('saas.kpi.lapsed')}
          value={data === undefined ? none : format.integer(data.lapsed)}
          lowerIsBetter
        />
      </div>
      {q.isPending ? (
        <QueryState status="pending" />
      ) : q.isError ? (
        <QueryState
          status="error"
          onRetry={() => {
            void q.refetch();
          }}
        />
      ) : q.data.tenants.length === 0 ? (
        <p className="text-om-sm text-om-secondary">{t('saas.empty')}</p>
      ) : (
        q.data.tenants.map((tenant) => (
          <div key={tenant.ci.id} data-tenant={tenant.vendor}>
            <Card as="section" padding="24" className="flex flex-col gap-om-12">
              <SectionTitle
                as="h2"
                size="sm"
                description={t('saas.tenant.summary', {
                  users: tenant.users === null ? none : format.integer(tenant.users),
                  active: tenant.activeUsers === null ? none : format.integer(tenant.activeUsers),
                  sso: tenant.ssoApplications === null ? none : format.integer(tenant.ssoApplications),
                })}
              >
                <Link href={href(tenant.ci.id)} className="hover:text-om-cyan">
                  {tenant.vendor + (tenant.edition === null ? '' : ' · ' + tenant.edition)}
                </Link>
              </SectionTitle>
              {tenant.domains.length > 0 ? (
                <p className="font-om-mono text-om-2xs text-om-muted">{tenant.domains.join(', ')}</p>
              ) : null}
              <div className="overflow-x-auto">
                <table className={tableClass}>
                  <thead className={theadClass}>
                    <tr>
                      <th scope="col" className={thClass}>
                        {t('saas.table.product')}
                      </th>
                      <th scope="col" className={thClass}>
                        {t('saas.table.seats')}
                      </th>
                      <th scope="col" className={thClass}>
                        {t('saas.table.renewal')}
                      </th>
                      <th scope="col" className={thClass}>
                        {t('saas.table.flows')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {tenant.subscriptions.map((s) => (
                      <tr
                        key={s.ci.id}
                        className={rowClass}
                        data-subscription={s.product}
                        data-state={s.state}
                      >
                        <td className={tdClass}>
                          <Link href={href(s.ci.id)} className="text-om-primary hover:text-om-cyan">
                            {s.product}
                          </Link>
                          {s.sku !== null ? (
                            <span className="block font-om-mono text-om-2xs text-om-muted">{s.sku}</span>
                          ) : null}
                        </td>
                        <td className={tdClass}>
                          {s.seatsTotal === null || s.seatsAssigned === null ? (
                            none
                          ) : (
                            <span className="flex min-w-40 flex-col gap-om-2">
                              <Bar
                                value={s.seatsAssigned}
                                max={Math.max(s.seatsTotal, 1)}
                                accent={s.underused ? accents.amber : accents.cyan}
                                label={t('saas.table.seats')}
                                glowing={false}
                              />
                              <span className="text-om-2xs text-om-secondary">
                                {t('saas.seats', {
                                  assigned: format.integer(s.seatsAssigned),
                                  total: format.integer(s.seatsTotal),
                                  unused: format.integer(s.unusedSeats ?? 0),
                                })}
                              </span>
                              {s.underused ? (
                                <Tag variant="state" state="at_risk">
                                  {t('saas.underused')}
                                </Tag>
                              ) : null}
                            </span>
                          )}
                        </td>
                        <td className={tdClass}>
                          <span className="flex flex-col gap-om-2">
                            {s.subscriptionEnd !== null ? (
                              <span className="text-om-secondary">{format.date(s.subscriptionEnd)}</span>
                            ) : null}
                            <StateBadge
                              state={BADGE[s.state]}
                              label={
                                s.daysToRenewal === null
                                  ? t(('saas.state.' + s.state) as MessageKey)
                                  : s.daysToRenewal < 0
                                    ? t('saas.lapsedAgo', { days: format.integer(-s.daysToRenewal) })
                                    : t('saas.renewsIn', { days: format.integer(s.daysToRenewal) })
                              }
                            />
                          </span>
                        </td>
                        <td className={tdClass + ' text-om-xs text-om-secondary'}>
                          {s.dataFlows.length === 0
                            ? none
                            : s.dataFlows.map((f) => (
                                <span key={f.application.id} className="block">
                                  <Link href={href(f.application.id)} className="hover:text-om-cyan">
                                    {f.application.displayName}
                                  </Link>
                                  {f.dataClass !== null
                                    ? ' · ' + t('saas.dataClass', { dataClass: f.dataClass })
                                    : ''}
                                </span>
                              ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        ))
      )}
    </div>
  );
}
