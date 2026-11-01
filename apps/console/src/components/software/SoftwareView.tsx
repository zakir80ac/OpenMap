'use client';
// REQ-UI-015 REQ-CMDB-030 REQ-CMDB-031 — Software and licences: the product catalogue discovered across the estate
// (vendor, version, footprint in instances and hosts, end of support), each product's licence position (entitlement
// against consumption, over-deployment, expiry, annual cost) and the open vulnerabilities per product. The posture
// card groups the licences that need a decision: over-deployed, expiring inside the horizon, already expired.
import { useQuery } from '@tanstack/react-query';
import { BSM, SOFTWARE, TIME } from '@openmap/constants';
import type { Locale } from '@openmap/i18n';
import { Card, Kpi, SectionTitle, StateBadge, Tag } from '@openmap/ui';
import Link from 'next/link';
import { useId, useMemo, useState, type ReactNode, type SyntheticEvent } from 'react';
import {
  Button,
  TextInput,
  rowClass,
  tableClass,
  tdClass,
  thClass,
  theadClass,
} from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { Icon } from '@/components/icons';
import { localizedHref } from '@/lib/locale-path';
import { softwareQuery, type LicenceSummary, type SoftwareProduct } from '@/lib/software-queries';
import { useFormatters, useT } from '@/providers';

export interface SoftwareViewProps {
  locale: Locale;
}

export type LicensedProduct = SoftwareProduct & { licence: LicenceSummary };

export interface LicencePosture {
  overDeployed: LicensedProduct[];
  expiring: LicensedProduct[];
  expired: LicensedProduct[];
}

function hasLicence(product: SoftwareProduct): product is LicensedProduct {
  return product.licence !== null;
}

/** Licences that need a decision: more consumed than entitled, expiring within `horizonDays` of `now`, or expired. */
export function licencePosture(
  products: ReadonlyArray<SoftwareProduct>,
  now: Date,
  horizonDays: number,
): LicencePosture {
  const limit = now.getTime() + horizonDays * TIME.msPerDay;
  const licensed = products.filter(hasLicence);
  const expiresWithin = (p: LicensedProduct): boolean => {
    if (p.licence.expired || p.licence.expiresAt === null) return false;
    const at = new Date(p.licence.expiresAt).getTime();
    return at >= now.getTime() && limit >= at;
  };
  return {
    overDeployed: licensed
      .filter((p) => p.licence.overDeployed)
      .sort(
        (a, b) => b.licence.consumed - b.licence.entitlement - (a.licence.consumed - a.licence.entitlement),
      ),
    expiring: licensed
      .filter(expiresWithin)
      .sort(
        (a, b) => new Date(a.licence.expiresAt ?? 0).getTime() - new Date(b.licence.expiresAt ?? 0).getTime(),
      ),
    expired: licensed.filter((p) => p.licence.expired),
  };
}

/** Consumption as a whole percentage of the entitlement; an entitlement of zero reads as fully consumed. */
export function utilisationPercent(licence: LicenceSummary): number {
  if (licence.entitlement <= 0) return licence.consumed > 0 ? BSM.percentScale : 0;
  return Math.round((licence.consumed / licence.entitlement) * BSM.percentScale);
}

function money(
  format: ReturnType<typeof useFormatters>,
  m: { amount: number; currency: string } | null,
): string {
  return m === null ? '' : format.number(m.amount) + ' ' + m.currency;
}

export function SoftwareView({ locale }: SoftwareViewProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const [text, setText] = useState('');
  const [applied, setApplied] = useState('');
  const [licensedOnly, setLicensedOnly] = useState(false);
  const products = useQuery(softwareQuery({ text: applied === '' ? null : applied, licensedOnly }));
  const list = products.data ?? [];
  const posture = useMemo(() => licencePosture(list, new Date(), SOFTWARE.expiryHorizonDays), [list]);
  const totals = useMemo(() => {
    let instances = 0;
    let vulnerable = 0;
    for (const p of list) {
      instances += p.instances;
      if (p.vulnerabilities > 0) vulnerable += 1;
    }
    return { instances, vulnerable };
  }, [list]);

  const ciHref = (ciId: string): string => localizedHref(locale, '/cmdb/' + encodeURIComponent(ciId));
  const vulnerabilitiesHref = localizedHref(locale, '/vulnerabilities');

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setApplied(text.trim());
  };

  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle as="h1" size="lg" eyebrow={t('app.name')} description={t('software.subtitle')}>
        {t('software.title')}
      </SectionTitle>

      <div className="grid grid-cols-2 gap-om-12 md:grid-cols-5">
        <Kpi label={t('software.kpi.products')} value={format.integer(list.length)} />
        <Kpi label={t('software.kpi.instances')} value={format.integer(totals.instances)} />
        <Kpi
          label={t('software.kpi.overDeployed')}
          value={format.integer(posture.overDeployed.length)}
          delta={posture.overDeployed.length}
          deltaLabel=""
          lowerIsBetter
        />
        <Kpi
          label={t('software.kpi.expiring', { days: format.integer(SOFTWARE.expiryHorizonDays) })}
          value={format.integer(posture.expiring.length)}
          delta={posture.expiring.length}
          deltaLabel=""
          lowerIsBetter
        />
        <Kpi
          label={t('software.kpi.vulnerable')}
          value={format.integer(totals.vulnerable)}
          delta={totals.vulnerable}
          deltaLabel=""
          lowerIsBetter
        />
      </div>

      <Card padding="24" className="flex flex-col gap-om-16">
        <SectionTitle
          as="h2"
          size="sm"
          description={t('software.catalogue.subtitle')}
          action={
            <form
              onSubmit={onSubmit}
              className="flex flex-wrap items-center gap-om-10"
              aria-label={t('software.filter.apply')}
            >
              <TextInput
                id={id + '-text'}
                type="search"
                aria-label={t('software.filter.text')}
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                }}
                className="w-auto"
              />
              <label className="flex items-center gap-om-6 text-om-xs text-om-secondary">
                <input
                  type="checkbox"
                  checked={licensedOnly}
                  onChange={(event) => {
                    setLicensedOnly(event.target.checked);
                  }}
                />
                <span>{t('software.filter.licensedOnly')}</span>
              </label>
              <Button type="submit" tone="quiet">
                {t('software.filter.apply')}
              </Button>
            </form>
          }
        >
          {t('software.catalogue.title')}
        </SectionTitle>
        {products.isPending ? (
          <QueryState status="pending" />
        ) : products.isError ? (
          <QueryState
            status="error"
            onRetry={() => {
              void products.refetch();
            }}
          />
        ) : list.length === 0 ? (
          <p className="text-om-sm text-om-secondary">{t('software.catalogue.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead className={theadClass}>
                <tr>
                  <th scope="col" className={thClass}>
                    {t('software.table.product')}
                  </th>
                  <th scope="col" className={thClass}>
                    {t('software.table.category')}
                  </th>
                  <th scope="col" className={thClass}>
                    {t('software.table.endOfSupport')}
                  </th>
                  <th scope="col" className={thClass}>
                    {t('software.table.footprint')}
                  </th>
                  <th scope="col" className={thClass}>
                    {t('software.table.licence')}
                  </th>
                  <th scope="col" className={thClass}>
                    {t('software.table.vulnerabilities')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.ci.id} className={rowClass}>
                    <td className={tdClass}>
                      <Link href={ciHref(p.ci.id)} className="text-om-cyan hover:underline">
                        {p.vendor + ' ' + p.name}
                      </Link>
                      <span className="block font-om-mono text-om-2xs text-om-muted">{p.version}</span>
                    </td>
                    <td className={tdClass + ' text-om-secondary'}>
                      {p.category === null ? t('common.none') : p.category}
                    </td>
                    <td className={tdClass + ' whitespace-nowrap text-om-secondary'}>
                      {p.endOfSupport === null ? t('common.none') : format.dateTime(p.endOfSupport)}
                    </td>
                    <td className={tdClass + ' text-om-secondary'}>
                      {t('software.footprint', {
                        instances: format.integer(p.instances),
                        hosts: format.integer(p.hosts),
                        running: format.integer(p.running),
                      })}
                    </td>
                    <td className={tdClass}>
                      {p.licence === null ? (
                        <span className="text-om-muted">{t('software.licence.none')}</span>
                      ) : (
                        <LicenceCell licence={p.licence} />
                      )}
                    </td>
                    <td className={tdClass}>
                      {p.vulnerabilities === 0 ? (
                        <span className="text-om-muted">{t('common.none')}</span>
                      ) : (
                        <Link href={vulnerabilitiesHref} className="text-om-rose hover:underline">
                          {t('software.vulnerabilities.open', { count: format.integer(p.vulnerabilities) })}
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card padding="24" className="flex flex-col gap-om-16">
        <SectionTitle
          as="h2"
          size="sm"
          description={t('software.posture.subtitle', { days: format.integer(SOFTWARE.expiryHorizonDays) })}
          action={<Icon name="software" className="size-5 text-om-violet" />}
        >
          {t('software.posture.title')}
        </SectionTitle>
        {products.isPending ? (
          <QueryState status="pending" />
        ) : posture.overDeployed.length + posture.expiring.length + posture.expired.length === 0 ? (
          <p className="text-om-sm text-om-secondary">{t('software.posture.empty')}</p>
        ) : (
          <div className="grid grid-cols-1 gap-om-12 md:grid-cols-3">
            <PostureGroup
              title={t('software.posture.overDeployed')}
              state="down"
              products={posture.overDeployed}
              ciHref={ciHref}
            />
            <PostureGroup
              title={t('software.posture.expiring')}
              state="at_risk"
              products={posture.expiring}
              ciHref={ciHref}
            />
            <PostureGroup
              title={t('software.posture.expired')}
              state="degraded"
              products={posture.expired}
              ciHref={ciHref}
            />
          </div>
        )}
      </Card>
    </div>
  );
}

interface LicenceCellProps {
  licence: LicenceSummary;
}

function LicenceCell({ licence }: LicenceCellProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const percent = utilisationPercent(licence);
  return (
    <div className="flex flex-col gap-om-4">
      <span className="text-om-primary">
        {t('software.licence.usage', {
          consumed: format.integer(licence.consumed),
          entitlement: format.integer(licence.entitlement),
          metric: licence.metric,
        })}
        <span className="ms-om-6 font-om-mono text-om-2xs text-om-muted">
          {format.integer(percent) + '%'}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-om-6 text-om-2xs text-om-secondary">
        <Tag>{licence.licenceType}</Tag>
        {licence.overDeployed ? <StateBadge state="down" label={t('software.licence.overDeployed')} /> : null}
        {licence.expired ? (
          <StateBadge state="degraded" label={t('software.licence.expired')} />
        ) : licence.expiresAt !== null ? (
          <span>{t('software.licence.expiresAt', { when: format.dateTime(licence.expiresAt) })}</span>
        ) : null}
        {licence.annualCost !== null ? (
          <span>{t('software.licence.cost', { cost: money(format, licence.annualCost) })}</span>
        ) : null}
      </span>
    </div>
  );
}

interface PostureGroupProps {
  title: string;
  state: 'down' | 'degraded' | 'at_risk';
  products: ReadonlyArray<LicensedProduct>;
  ciHref: (ciId: string) => string;
}

function PostureGroup({ title, state, products, ciHref }: PostureGroupProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-om-8 rounded-om-panel border border-om-border-glass bg-om-surface2 p-om-16"
    >
      <div className="flex items-center gap-om-8">
        <StateBadge state={state} label={title} />
        <span className="ms-auto font-om-mono text-om-xs text-om-muted">
          {format.integer(products.length)}
        </span>
      </div>
      {products.length === 0 ? (
        <p className="text-om-xs text-om-muted">{t('common.none')}</p>
      ) : (
        <ul className="flex flex-col gap-om-6 text-om-xs">
          {products.map((p) => (
            <li key={p.ci.id} className="flex flex-col">
              <Link href={ciHref(p.licence.ci.id)} className="text-om-cyan hover:underline">
                {p.vendor + ' ' + p.name + ' ' + p.version}
              </Link>
              <span className="text-om-secondary">
                {t('software.licence.usage', {
                  consumed: format.integer(p.licence.consumed),
                  entitlement: format.integer(p.licence.entitlement),
                  metric: p.licence.metric,
                })}
                {p.licence.expiresAt !== null ? ' · ' + format.dateTime(p.licence.expiresAt) : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
