'use client';
// REQ-CMDB-026 REQ-CMDB-027 REQ-CMDB-028 REQ-CMDB-029 (ADR-035) — Commercial: the contract register (with documents and
// renewal dates), vendors with their escalation contacts, and customers, departments and cost centres, over the
// vendor, contract and cost_centre CIs. Headline figures: active contracts, those ending inside the at-risk window,
// those already ended, and the vendors and cost centres on record. Operators add and edit; everyone reads.
import { useQuery } from '@tanstack/react-query';
import { COMMERCIAL, ROLES } from '@openmap/constants';
import type { Locale } from '@openmap/i18n';
import { Kpi, Pill, SectionTitle } from '@openmap/ui';
import { useState, type ReactNode } from 'react';
import { useCan } from '@/lib/auth';
import { contractsQuery, costCentresQuery, vendorsQuery } from '@/lib/commercial-queries';
import { useFormatters, useT } from '@/providers';
import { ContractsTab, endState } from './ContractsTab';
import { CostCentresTab } from './CostCentresTab';
import { VendorsTab } from './VendorsTab';

export const COMMERCIAL_TABS = ['contracts', 'vendors', 'costCentres'] as const;
export type CommercialTab = (typeof COMMERCIAL_TABS)[number];

export interface CommercialViewProps {
  locale: Locale;
}

export function CommercialView({ locale }: CommercialViewProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const can = useCan();
  const canOperate = can(ROLES.operator);
  const [tab, setTab] = useState<CommercialTab>('contracts');
  const contracts = useQuery(contractsQuery({}));
  const vendors = useQuery(vendorsQuery(null));
  const centres = useQuery(costCentresQuery());
  const all = contracts.data ?? [];
  const active = all.filter((c) => !c.expired);
  const ending = active.filter((c) => endState(c) === 'at_risk');
  const expired = all.filter((c) => c.expired);

  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle as="h1" size="lg" eyebrow={t('app.name')} description={t('commercial.subtitle')}>
        {t('commercial.title')}
      </SectionTitle>
      <div className="grid grid-cols-2 gap-om-12 md:grid-cols-5">
        <Kpi label={t('commercial.kpi.active')} value={format.integer(active.length)} />
        <Kpi
          label={t('commercial.kpi.ending', { days: format.integer(COMMERCIAL.atRiskDays) })}
          value={format.integer(ending.length)}
          delta={ending.length}
          deltaLabel=""
          lowerIsBetter
        />
        <Kpi label={t('commercial.kpi.expired')} value={format.integer(expired.length)} delta={expired.length} deltaLabel="" lowerIsBetter />
        <Kpi label={t('commercial.kpi.vendors')} value={format.integer(vendors.data?.length ?? 0)} />
        <Kpi label={t('commercial.kpi.costCentres')} value={format.integer(centres.data?.length ?? 0)} />
      </div>
      <div className="flex flex-wrap gap-om-8" role="tablist" aria-label={t('commercial.title')}>
        {COMMERCIAL_TABS.map((key) => (
          <span key={key} role="presentation" data-testid={'commercial-tab-' + key}>
            <Pill
              selected={tab === key}
              onClick={() => {
                setTab(key);
              }}
            >
              {t(('commercial.tab.' + key) as 'commercial.tab.contracts')}
            </Pill>
          </span>
        ))}
      </div>
      {tab === 'contracts' ? <ContractsTab locale={locale} canOperate={canOperate} /> : null}
      {tab === 'vendors' ? <VendorsTab canOperate={canOperate} /> : null}
      {tab === 'costCentres' ? <CostCentresTab canOperate={canOperate} /> : null}
    </div>
  );
}
