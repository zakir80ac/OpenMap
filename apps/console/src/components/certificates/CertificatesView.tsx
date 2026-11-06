'use client';
// REQ-CMDB-032 (ADR-036) — Certificates: every certificate discovery found on a TLS endpoint, soonest expiry first, with
// its subject and names, issuer, days left, key and signature weaknesses, the endpoints it secures and the last expiry
// alert raised; filters by horizon, expired, self-signed, weak and text, and certificate authorities on request.
// Headline counts: certificates, expiring inside the at-risk window, expired, weak, self-signed.
import { useQuery } from '@tanstack/react-query';
import { CERTIFICATES } from '@openmap/constants';
import type { Locale, MessageKey } from '@openmap/i18n';
import { Card, Kpi, SectionTitle, StateBadge, Tag } from '@openmap/ui';
import Link from 'next/link';
import { useId, useState, type ReactNode } from 'react';
import {
  Field,
  Select,
  TextInput,
  rowClass,
  tableClass,
  tdClass,
  thClass,
  theadClass,
} from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { certificatesQuery, type Certificate, type CertificateFilter } from '@/lib/certificate-queries';
import { localizedHref } from '@/lib/locale-path';
import { useFormatters, useT } from '@/providers';

/** The shortest horizon is the at-risk window: renewal must already be under way. */
const AT_RISK_DAYS = CERTIFICATES.alertThresholdsDays[1];

export function expiryState(c: Pick<Certificate, 'daysLeft' | 'expired'>): 'down' | 'at_risk' | 'degraded' | 'healthy' | 'unknown' {
  if (c.daysLeft === null) return 'unknown';
  if (c.expired) return 'down';
  if (c.daysLeft <= AT_RISK_DAYS) return 'at_risk';
  return c.daysLeft <= CERTIFICATES.alertThresholdsDays[0] ? 'degraded' : 'healthy';
}

/** The common name of an X.509 subject, else the whole subject. */
export function commonName(subject: string): string {
  const match = /(?:^|,\s*)CN=([^,]+)/.exec(subject);
  return match?.[1]?.trim() ?? subject;
}

function weaknessKey(w: string): MessageKey {
  return ('certificates.weakness.' + w) as MessageKey;
}

type Toggle = '' | 'yes' | 'no';

function toggleValue(v: Toggle): boolean | undefined {
  return v === '' ? undefined : v === 'yes';
}

export function CertificatesView({ locale }: { locale: Locale }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const [text, setText] = useState('');
  const [horizon, setHorizon] = useState('');
  const [expired, setExpired] = useState<Toggle>('');
  const [weak, setWeak] = useState<Toggle>('');
  const [selfSigned, setSelfSigned] = useState<Toggle>('');
  const [authorities, setAuthorities] = useState(false);
  const filter: CertificateFilter = {};
  if (text.trim() !== '') filter.text = text.trim();
  if (horizon !== '') filter.expiringWithinDays = Number(horizon);
  const e = toggleValue(expired);
  if (e !== undefined) filter.expired = e;
  const w = toggleValue(weak);
  if (w !== undefined) filter.weak = w;
  const s = toggleValue(selfSigned);
  if (s !== undefined) filter.selfSigned = s;
  if (authorities) filter.includeAuthorities = true;
  const certificates = useQuery(certificatesQuery(filter));
  const all = useQuery(certificatesQuery({}));
  const everything = all.data ?? [];
  const list = certificates.data ?? [];
  const ciHref = (ciId: string): string => localizedHref(locale, '/cmdb/' + encodeURIComponent(ciId));
  const toggle = (key: string, label: MessageKey, value: Toggle, set: (v: Toggle) => void): ReactNode => (
    <Field id={id + '-' + key} label={t(label)}>
      <Select
        id={id + '-' + key}
        value={value}
        onChange={(event) => {
          set(event.target.value as Toggle);
        }}
      >
        <option value="">{t('certificates.filter.any')}</option>
        <option value="yes">{t('certificates.filter.yes')}</option>
        <option value="no">{t('certificates.filter.no')}</option>
      </Select>
    </Field>
  );

  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle as="h1" size="lg" eyebrow={t('app.name')} description={t('certificates.subtitle', { thresholds: new Intl.ListFormat(locale, { type: 'conjunction' }).format(CERTIFICATES.alertThresholdsDays.map((d) => format.integer(d))) })}>
        {t('certificates.title')}
      </SectionTitle>
      <div className="grid grid-cols-2 gap-om-12 md:grid-cols-5">
        <Kpi label={t('certificates.kpi.total')} value={format.integer(everything.length)} />
        <Kpi
          label={t('certificates.kpi.expiring', { days: format.integer(AT_RISK_DAYS) })}
          value={format.integer(everything.filter((c) => expiryState(c) === 'at_risk').length)}
          lowerIsBetter
        />
        <Kpi label={t('certificates.kpi.expired')} value={format.integer(everything.filter((c) => c.expired).length)} lowerIsBetter />
        <Kpi label={t('certificates.kpi.weak')} value={format.integer(everything.filter((c) => c.weaknesses.length > 0).length)} lowerIsBetter />
        <Kpi label={t('certificates.kpi.selfSigned')} value={format.integer(everything.filter((c) => c.selfSigned).length)} lowerIsBetter />
      </div>
      <Card padding="24" className="flex flex-col gap-om-16" as="section">
        <SectionTitle as="h2" size="sm" description={t('certificates.register.subtitle')}>
          {t('certificates.register.title')}
        </SectionTitle>
        <div className="flex flex-wrap items-end gap-om-10">
          <Field id={id + '-text'} label={t('certificates.filter.text')}>
            <TextInput
              id={id + '-text'}
              type="search"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
              }}
            />
          </Field>
          <Field id={id + '-horizon'} label={t('certificates.filter.expiringWithin')}>
            <Select
              id={id + '-horizon'}
              value={horizon}
              onChange={(event) => {
                setHorizon(event.target.value);
              }}
            >
              <option value="">{t('certificates.filter.anyExpiry')}</option>
              {CERTIFICATES.expiryHorizonsDays.map((days) => (
                <option key={days} value={String(days)}>
                  {t('certificates.filter.days', { days: format.integer(days) })}
                </option>
              ))}
            </Select>
          </Field>
          {toggle('expired', 'certificates.filter.expired', expired, setExpired)}
          {toggle('weak', 'certificates.filter.weak', weak, setWeak)}
          {toggle('selfSigned', 'certificates.filter.selfSigned', selfSigned, setSelfSigned)}
          <label className="flex items-center gap-om-6 pb-om-6 text-om-xs text-om-secondary">
            <input
              type="checkbox"
              checked={authorities}
              onChange={(event) => {
                setAuthorities(event.target.checked);
              }}
            />
            <span>{t('certificates.filter.authorities')}</span>
          </label>
        </div>
        {certificates.isPending ? (
          <QueryState status="pending" />
        ) : certificates.isError ? (
          <QueryState
            status="error"
            onRetry={() => {
              void certificates.refetch();
            }}
          />
        ) : list.length === 0 ? (
          <p className="text-om-sm text-om-secondary">{t('certificates.register.empty')}</p>
        ) : (
          <div className="overflow-x-auto" data-testid="certificate-register">
            <table className={tableClass}>
              <thead className={theadClass}>
                <tr>
                  <th scope="col" className={thClass}>
                    {t('certificates.table.subject')}
                  </th>
                  <th scope="col" className={thClass}>
                    {t('certificates.table.expires')}
                  </th>
                  <th scope="col" className={thClass}>
                    {t('certificates.table.key')}
                  </th>
                  <th scope="col" className={thClass}>
                    {t('certificates.table.endpoints')}
                  </th>
                  <th scope="col" className={thClass}>
                    {t('certificates.table.issuer')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.ci.id} className={rowClass} data-certificate={commonName(c.subject)}>
                    <td className={tdClass}>
                      <Link href={ciHref(c.ci.id)} className="text-om-primary hover:text-om-cyan">
                        {commonName(c.subject)}
                      </Link>
                      {c.dnsNames.length > 0 ? <span className="block font-om-mono text-om-2xs text-om-muted">{c.dnsNames.join(', ')}</span> : null}
                      <span className="mt-om-2 flex flex-wrap gap-om-4">
                        {c.isCa ? <Tag>{t('certificates.tag.authority')}</Tag> : null}
                        {c.selfSigned ? <Tag>{t('certificates.tag.selfSigned')}</Tag> : null}
                      </span>
                    </td>
                    <td className={tdClass}>
                      {c.notAfter === null ? (
                        t('common.none')
                      ) : (
                        <span className="flex flex-col gap-om-2">
                          <span className="text-om-secondary">{format.date(c.notAfter)}</span>
                          <StateBadge
                            state={expiryState(c)}
                            label={
                              c.expired
                                ? t('certificates.expiredAgo', { days: format.integer(-(c.daysLeft ?? 0)) })
                                : t('certificates.daysLeft', { days: format.integer(c.daysLeft ?? 0) })
                            }
                          />
                          {c.lastAlertDays !== null ? (
                            <span className="text-om-2xs text-om-muted">
                              {c.lastAlertDays === 0
                                ? t('certificates.alerted.expired')
                                : t('certificates.alerted.days', { days: format.integer(c.lastAlertDays) })}
                            </span>
                          ) : null}
                        </span>
                      )}
                    </td>
                    <td className={tdClass}>
                      <span className="font-om-mono text-om-xs text-om-secondary">
                        {[c.keyAlgorithm, c.keyBits === null ? null : format.integer(c.keyBits)].filter((v) => v !== null).join(' ') || t('common.none')}
                      </span>
                      {c.signatureAlgorithm !== null ? <span className="block font-om-mono text-om-2xs text-om-muted">{c.signatureAlgorithm}</span> : null}
                      <span className="mt-om-2 flex flex-wrap gap-om-4">
                        {c.weaknesses.map((w) => (
                          <Tag key={w} variant="state" state="at_risk">
                            {t(weaknessKey(w))}
                          </Tag>
                        ))}
                      </span>
                    </td>
                    <td className={tdClass + ' text-om-secondary'}>
                      {c.endpoints.length === 0
                        ? t('common.none')
                        : c.endpoints.map((ep) => (
                            <Link key={ep.listener.id} href={ciHref(ep.listener.id)} className="block font-om-mono text-om-2xs hover:text-om-cyan">
                              {(ep.host ?? ep.listener.displayName) + (ep.port === null ? '' : ':' + String(ep.port))}
                              {ep.tlsVersion !== null ? ' · ' + ep.tlsVersion : ''}
                            </Link>
                          ))}
                    </td>
                    <td className={tdClass + ' text-om-secondary'}>
                      {c.issuedBy !== null ? (
                        <Link href={ciHref(c.issuedBy.id)} className="hover:text-om-cyan">
                          {c.issuedBy.displayName}
                        </Link>
                      ) : (
                        (c.issuer === null ? t('common.none') : commonName(c.issuer))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
