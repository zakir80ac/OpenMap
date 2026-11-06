'use client';
// REQ-CMDB-014 (ADR-037) — the Parts tab of a CI: what is inside it (sockets, DIMMs, drives, adapters, HBAs, power
// supplies) grouped by kind, the totals they add up to, and on request the parts a later sweep no longer reported.
import { useQuery } from '@tanstack/react-query';
import { componentTotals } from '@openmap/contracts';
import type { Locale } from '@openmap/i18n';
import { Card, SectionTitle, StateBadge } from '@openmap/ui';
import { useId, useState, type ReactNode } from 'react';
import { rowClass, tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { formatBytes } from '@/components/dependencies/traffic';
import { ciPartsQuery, type HardwareComponent } from '@/lib/component-queries';
import { useFormatters, useT } from '@/providers';
import { Capacity, PartDetails, kindKey, kindOrder } from './PartCells';

function byKind(parts: readonly HardwareComponent[]): HardwareComponent[] {
  return [...parts].sort(
    (a, b) =>
      kindOrder(a.kind) - kindOrder(b.kind) || a.slot.localeCompare(b.slot, undefined, { numeric: true }),
  );
}

export function CiPartsPanel({ ciId, locale }: { ciId: string; locale: Locale }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const [removed, setRemoved] = useState(false);
  const query = useQuery(ciPartsQuery(ciId, removed));
  const parts = byKind(query.data ?? []);
  const current = parts.filter((p) => p.removedAt === null);
  const totals = componentTotals(
    current.map((p) =>
      p.capacityBytes === null ? { kind: p.kind } : { kind: p.kind, capacityBytes: p.capacityBytes },
    ),
  );

  return (
    <div data-testid="ci-parts">
      <Card as="section" className="flex flex-col gap-om-12">
        <SectionTitle
          as="h2"
          size="sm"
          description={t('parts.ci.subtitle', {
            cpu: format.integer(totals.count.cpu),
            memory: formatBytes(locale, totals.memoryBytes),
            disks: format.integer(totals.count.disk),
            storage: formatBytes(locale, totals.diskBytes),
          })}
        >
          {t('parts.ci.title')}
        </SectionTitle>
        <label htmlFor={id + '-removed'} className="flex items-center gap-om-6 text-om-xs text-om-secondary">
          <input
            id={id + '-removed'}
            type="checkbox"
            checked={removed}
            onChange={(event) => {
              setRemoved(event.target.checked);
            }}
          />
          <span>{t('parts.ci.showRemoved')}</span>
        </label>
        {query.isPending ? (
          <QueryState status="pending" />
        ) : query.isError ? (
          <QueryState
            status="error"
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : parts.length === 0 ? (
          <p className="text-om-sm text-om-secondary">{t('parts.ci.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead className={theadClass}>
                <tr>
                  <th scope="col" className={thClass}>
                    {t('parts.table.kind')}
                  </th>
                  <th scope="col" className={thClass}>
                    {t('parts.table.slot')}
                  </th>
                  <th scope="col" className={thClass}>
                    {t('parts.table.model')}
                  </th>
                  <th scope="col" className={thClass}>
                    {t('parts.table.serial')}
                  </th>
                  <th scope="col" className={thClass}>
                    {t('parts.table.capacity')}
                  </th>
                  <th scope="col" className={thClass}>
                    {t('parts.table.details')}
                  </th>
                  <th scope="col" className={thClass}>
                    {t('parts.table.seen')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {parts.map((p) => (
                  <tr key={p.id} className={rowClass} data-part={p.kind + ':' + p.slot}>
                    <td className={tdClass}>{t(kindKey(p.kind))}</td>
                    <td className={tdClass + ' font-om-mono text-om-xs'}>{p.slot}</td>
                    <td className={tdClass}>
                      <span className="text-om-primary">
                        {p.model ?? p.partNumber ?? t('parts.unknownModel')}
                      </span>
                      {p.manufacturer !== null ? (
                        <span className="block text-om-2xs text-om-muted">{p.manufacturer}</span>
                      ) : null}
                      {p.partNumber !== null && p.model !== null ? (
                        <span className="block font-om-mono text-om-2xs text-om-muted">{p.partNumber}</span>
                      ) : null}
                    </td>
                    <td className={tdClass + ' font-om-mono text-om-xs text-om-secondary'}>
                      {p.serialNumber ?? t('common.none')}
                    </td>
                    <td className={tdClass}>
                      <Capacity part={p} locale={locale} />
                    </td>
                    <td className={tdClass}>
                      <PartDetails details={p.details} t={t} format={format} />
                      {p.firmware !== null ? (
                        <span className="mt-om-2 block font-om-mono text-om-2xs text-om-muted">
                          {t('parts.firmware', { version: p.firmware })}
                        </span>
                      ) : null}
                    </td>
                    <td className={tdClass + ' text-om-xs text-om-secondary'}>
                      {p.removedAt !== null ? (
                        <StateBadge
                          state="down"
                          label={t('parts.removed', { when: format.dateTime(p.removedAt) })}
                        />
                      ) : (
                        t('parts.since', { when: format.dateTime(p.firstSeenAt) })
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
