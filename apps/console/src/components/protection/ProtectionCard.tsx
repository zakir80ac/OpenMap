'use client';
// REQ-INT-017 (ADR-075) — the CI detail's Protection card for the types a backup protects (VMs, hosts, databases and
// database clusters): protected, past its RPO or unprotected; the last good backup and its age; the RPO the CI is
// judged against beside the strictest policy RPO; every covering policy (Veeam job, Commvault plan or storage policy,
// Rubrik SLA domain) with its server, last result, restore points, retention and agents, and the host a database
// inherits an application-aware cover from; and the business services it supports with their tier and required RPO.
// Hidden when the API answers null (a type no backup protects).
import { useQuery } from '@tanstack/react-query';
import type { Locale } from '@openmap/i18n';
import { Card, SectionTitle, StateBadge, Tag } from '@openmap/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { QueryState } from '@/components/common/QueryState';
import { localizedHref } from '@/lib/locale-path';
import { ciProtectionQuery, type BackupCover, type CiProtection } from '@/lib/protection-queries';
import { useFormatters, useT } from '@/providers';
import { STATE_BADGE, STATE_KEY, duration, kindLabel, resultBadge, resultLabel, vendorLabel } from './labels';

export interface ProtectionCardProps {
  locale: Locale;
  ciId: string;
}

export function ProtectionCard({ locale, ciId }: ProtectionCardProps): ReactNode {
  const t = useT();
  const q = useQuery(ciProtectionQuery(ciId));
  if (q.isSuccess && q.data === null) return null;
  return (
    <div data-testid="protection-card" className="contents">
      <Card as="section" className="flex flex-col gap-om-12">
        <SectionTitle as="h2" size="sm" description={t('protection.card.hint')}>
          {t('protection.card.title')}
        </SectionTitle>
        {q.isPending ? (
          <QueryState status="pending" />
        ) : q.isError ? (
          <QueryState
            status="error"
            onRetry={() => {
              void q.refetch();
            }}
          />
        ) : q.data === null ? null : (
          <ProtectionBody locale={locale} protection={q.data} />
        )}
      </Card>
    </div>
  );
}

function ProtectionBody({ locale, protection }: { locale: Locale; protection: CiProtection }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const href = (id: string): string => localizedHref(locale, '/cmdb/' + encodeURIComponent(id));
  const p = protection;
  return (
    <div className="flex flex-col gap-om-12" data-state={p.state}>
      <div className="flex flex-wrap items-center gap-om-10">
        <StateBadge state={STATE_BADGE[p.state]} label={t(STATE_KEY[p.state])} />
        <span className="text-om-xs text-om-secondary">
          {t('protection.targetRpo', { rpo: duration(t, format, p.targetRpoMinutes) })}
        </span>
        {p.policyRpoMinutes !== null ? (
          <span className="text-om-xs text-om-muted">
            {t('protection.policyRpo', { rpo: duration(t, format, p.policyRpoMinutes) })}
          </span>
        ) : null}
      </div>
      <dl className="grid grid-cols-1 gap-x-om-16 gap-y-om-8 text-om-sm md:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
        <dt className="text-om-xs text-om-secondary">{t('protection.lastGoodBackup')}</dt>
        <dd className="text-om-primary" data-testid="protection-last-good">
          {p.lastGoodBackupAt === null ? (
            t('protection.neverBackedUp')
          ) : (
            <>
              <time dateTime={p.lastGoodBackupAt}>{format.dateTime(p.lastGoodBackupAt)}</time>
              {p.ageMinutes !== null ? (
                <span className="ms-om-8 text-om-xs text-om-secondary">
                  {t('protection.ago', { age: duration(t, format, p.ageMinutes) })}
                </span>
              ) : null}
            </>
          )}
        </dd>
      </dl>
      <div className="flex flex-col gap-om-6">
        <h3 className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
          {t('protection.covers')}
        </h3>
        {p.covers.length === 0 ? (
          <p className="text-om-sm text-om-secondary">{t('protection.noCovers')}</p>
        ) : (
          <ul className="flex flex-col gap-om-8">
            {p.covers.map((c) => (
              <CoverItem key={c.policy.id + (c.via?.id ?? '')} cover={c} href={href} />
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-om-6">
        <h3 className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
          {t('protection.services')}
        </h3>
        {p.services.length === 0 ? (
          <p className="text-om-sm text-om-secondary">{t('protection.noServices')}</p>
        ) : (
          <ul className="flex flex-col gap-om-4 text-om-sm">
            {p.services.map((s) => (
              <li key={s.service.id} className="flex flex-wrap items-center gap-om-8" data-service={s.service.id}>
                <Link href={href(s.service.id)} className="text-om-primary hover:text-om-cyan">
                  <bdi>{s.service.displayName}</bdi>
                </Link>
                <Tag>{t('protection.tier', { tier: format.integer(s.tier) })}</Tag>
                <span className="text-om-xs text-om-secondary">
                  {s.rpoMinutes === null
                    ? t('protection.serviceRpoNone')
                    : t('protection.serviceRpo', { rpo: duration(t, format, s.rpoMinutes) })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function CoverItem({ cover: c, href }: { cover: BackupCover; href: (id: string) => string }): ReactNode {
  const t = useT();
  const format = useFormatters();
  return (
    <li
      className="flex flex-col gap-om-4 rounded-om-control border border-om-border-glass px-om-10 py-om-8"
      data-cover={c.policy.id}
      data-vendor={c.vendor}
    >
      <span className="flex flex-wrap items-center gap-om-8">
        <Link href={href(c.policy.id)} className="font-medium text-om-primary hover:text-om-cyan">
          <bdi>{c.policy.displayName}</bdi>
        </Link>
        <Tag>{vendorLabel(t, c.vendor)}</Tag>
        <Tag>{kindLabel(t, c.policyKind)}</Tag>
        {c.lastResult !== null ? (
          <StateBadge state={resultBadge(c.lastResult)} label={resultLabel(t, c.lastResult)} />
        ) : null}
      </span>
      <span className="flex flex-wrap gap-x-om-12 gap-y-om-2 text-om-xs text-om-secondary">
        {c.server !== null ? (
          <span>
            {t('protection.serverLabel')}{' '}
            <bdi dir="ltr" className="font-om-mono">
              {c.server}
            </bdi>
          </span>
        ) : null}
        <span>
          {c.lastGoodBackupAt === null
            ? t('protection.neverBackedUp')
            : t('protection.coverLastGood', { when: format.dateTime(c.lastGoodBackupAt) })}
        </span>
        {c.rpoMinutes !== null ? (
          <span>{t('protection.coverRpo', { rpo: duration(t, format, c.rpoMinutes) })}</span>
        ) : null}
        {c.restorePoints !== null ? (
          <span>{t('protection.restorePoints', { count: format.integer(c.restorePoints) })}</span>
        ) : null}
        {c.retentionDays !== null ? (
          <span>{t('protection.retention', { days: format.integer(c.retentionDays) })}</span>
        ) : null}
      </span>
      {c.agents.length > 0 ? (
        <span className="flex flex-wrap gap-om-4" aria-label={t('protection.agents')}>
          {c.agents.map((a) => (
            <Tag key={a}>
              <bdi>{a}</bdi>
            </Tag>
          ))}
        </span>
      ) : null}
      {c.via !== null ? (
        <span className="text-om-xs text-om-secondary" data-via={c.via.id}>
          {t('protection.viaLabel')}{' '}
          <Link href={href(c.via.id)} className="text-om-primary hover:text-om-cyan">
            <bdi>{c.via.displayName}</bdi>
          </Link>
        </span>
      ) : null}
    </li>
  );
}
