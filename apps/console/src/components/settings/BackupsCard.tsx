'use client';
// REQ-INT-019 (ADR-066) — backups on the Settings screen, for administrators: whether the newest complete backup set is
// recent enough, and every set the backup service wrote (name, state, when, Postgres and ClickHouse sizes, CIs, schema
// migration, the reason a set failed), with how sets are taken and restored. Read-only: the backup service writes them.
import { useQuery } from '@tanstack/react-query';
import { BACKUP } from '@openmap/constants';
import type { BackupStatus } from '@openmap/contracts';
import { Card, SectionTitle, StateBadge, Tag, type UiState } from '@openmap/ui';
import type { ReactNode } from 'react';
import { rowClass, tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { gql } from '@/lib/graphql';
import { useFormatters, useT, type Translate } from '@/providers';

export interface BackupSet {
  name: string;
  status: BackupStatus;
  createdAt: string;
  completedAt: string | null;
  postgresBytes: number | null;
  clickhouseBytes: number | null;
  migration: string | null;
  cis: number | null;
  error: string | null;
}

export interface Backups {
  configured: boolean;
  stale: boolean;
  staleAfterHours: number;
  lastCompleteAt: string | null;
  sets: BackupSet[];
}

const QUERY =
  '{ backups { configured stale staleAfterHours lastCompleteAt sets { name status createdAt completedAt postgresBytes clickhouseBytes migration cis error } } }';

export const backupsQuery = {
  queryKey: ['backups'] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    gql<{ backups: Backups }>(QUERY, {}, signal).then((d) => d.backups),
};

const STATE: Record<BackupStatus, UiState> = { complete: 'healthy', running: 'unknown', failed: 'down' };

export function megabytes(t: Translate, number: (v: number) => string, bytes: number | null): string {
  return bytes === null
    ? ''
    : t('settings.backups.megabytes', { value: number(bytes / BACKUP.bytesPerMegabyte) });
}

export function BackupsCard(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const backups = useQuery(backupsQuery);
  const round = (v: number): string => format.integer(v);
  return (
    <Card padding="24" className="flex flex-col gap-om-16">
      <SectionTitle as="h2" size="sm" description={t('settings.backups.subtitle')}>
        {t('settings.backups.title')}
      </SectionTitle>
      {backups.isPending ? <QueryState status="pending" /> : null}
      {backups.isError ? <QueryState status="error" onRetry={() => void backups.refetch()} /> : null}
      {backups.data !== undefined ? (
        backups.data.configured ? (
          <>
            <div className="flex flex-wrap items-center gap-om-10" data-testid="backup-freshness">
              <StateBadge
                state={backups.data.stale ? 'down' : 'healthy'}
                label={
                  backups.data.stale
                    ? t('settings.backups.stale', { hours: format.integer(backups.data.staleAfterHours) })
                    : t('settings.backups.fresh')
                }
              />
              <span className="text-om-sm text-om-secondary">
                {backups.data.lastCompleteAt === null
                  ? t('settings.backups.none')
                  : t('settings.backups.last', { at: format.dateTime(backups.data.lastCompleteAt) })}
              </span>
            </div>
            {backups.data.sets.length === 0 ? null : (
              <div className="overflow-x-auto">
                <table className={tableClass} aria-label={t('settings.backups.title')}>
                  <thead className={theadClass}>
                    <tr>
                      <th scope="col" className={thClass}>
                        {t('settings.backups.col.name')}
                      </th>
                      <th scope="col" className={thClass}>
                        {t('settings.backups.col.state')}
                      </th>
                      <th scope="col" className={thClass}>
                        {t('settings.backups.col.when')}
                      </th>
                      <th scope="col" className={thClass}>
                        {t('settings.backups.col.postgres')}
                      </th>
                      <th scope="col" className={thClass}>
                        {t('settings.backups.col.clickhouse')}
                      </th>
                      <th scope="col" className={thClass}>
                        {t('settings.backups.col.cis')}
                      </th>
                      <th scope="col" className={thClass}>
                        {t('settings.backups.col.migration')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {backups.data.sets.map((s) => (
                      <tr key={s.name} className={rowClass} data-status={s.status}>
                        <td className={tdClass + ' font-om-mono text-om-primary'}>
                          <bdi>{s.name}</bdi>
                          {s.error !== null ? (
                            <span className="block font-om-body text-om-2xs text-om-rose">{s.error}</span>
                          ) : null}
                        </td>
                        <td className={tdClass}>
                          <Tag variant="state" state={STATE[s.status]}>
                            {t(`settings.backups.status.${s.status}`)}
                          </Tag>
                        </td>
                        <td className={tdClass + ' whitespace-nowrap text-om-secondary'}>
                          {format.dateTime(s.completedAt ?? s.createdAt)}
                        </td>
                        <td className={tdClass + ' font-om-mono'}>{megabytes(t, round, s.postgresBytes)}</td>
                        <td className={tdClass + ' font-om-mono'}>
                          {megabytes(t, round, s.clickhouseBytes)}
                        </td>
                        <td className={tdClass + ' font-om-mono'}>
                          {s.cis === null ? '' : format.integer(s.cis)}
                        </td>
                        <td className={tdClass + ' font-om-mono text-om-2xs text-om-secondary'}>
                          <bdi>{s.migration ?? ''}</bdi>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-om-2xs text-om-muted">{t('settings.backups.howto')}</p>
          </>
        ) : (
          <p className="text-om-sm text-om-secondary">{t('settings.backups.unconfigured')}</p>
        )
      ) : null}
    </Card>
  );
}
