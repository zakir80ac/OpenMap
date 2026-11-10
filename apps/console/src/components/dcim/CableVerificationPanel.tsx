'use client';
// REQ-DCIM-008 (ADR-062) — cable verification on the DCIM Cabling tab:
// - totals: recorded cables verified by discovery, contradicted by it, not observed, not verifiable, and the observed
//   links no cable explains;
// - the recorded cables with their verdict, the ones to act on first; a mismatch names what was seen instead;
// - the undocumented links with the label a recorded cable would get; an operator starts the cable form from one;
// - the cable labels as a CSV download for printing.
import { useMutation, useQuery } from '@tanstack/react-query';
import { CABLING } from '@openmap/constants';
import type { CableVerificationReason, CableVerificationStatus } from '@openmap/contracts';
import type { MessageKey } from '@openmap/i18n';
import { Card, Kpi, SectionTitle, Tag } from '@openmap/ui';
import { useMemo, useState, type ReactNode } from 'react';
import { Button, rowClass, tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import {
  cablingVerificationQuery,
  fetchCablingLabelsCsv,
  type CableVerification,
  type ObservedLink,
} from '@/lib/cabling-queries';
import { useFormatters, useT } from '@/providers';

/** The verdicts to act on first. */
const STATUS_ORDER: readonly CableVerificationStatus[] = [
  'mismatch',
  'unverifiable',
  'unobserved',
  'verified',
];
const LABELS_FILE = 'openmap-cable-labels.csv';
const CSV_TYPE = 'text/csv;charset=utf-8';

export function statusKey(status: CableVerificationStatus): MessageKey {
  return `dcim.cabling.verify.status.${status}`;
}

export function reasonKey(reason: CableVerificationReason): MessageKey {
  return `dcim.cabling.verify.reason.${reason}`;
}

/** Cables by verdict (mismatches first), then by label. */
export function sortVerdicts(cables: readonly CableVerification[]): CableVerification[] {
  return [...cables].sort(
    (x, y) =>
      STATUS_ORDER.indexOf(x.status) - STATUS_ORDER.indexOf(y.status) ||
      x.cable.label.localeCompare(y.cable.label),
  );
}

/** Hands the text to the browser as a file; a no-op where there is no document (server render, tests without a DOM URL API). */
export function saveCsv(name: string, csv: string): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([csv], { type: CSV_TYPE }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function CableVerificationPanel({
  operator,
  onRecord,
}: {
  operator: boolean;
  onRecord: (link: ObservedLink) => void;
}): ReactNode {
  const t = useT();
  const format = useFormatters();
  const verification = useQuery(cablingVerificationQuery());
  const [allCables, setAllCables] = useState(false);
  const [allLinks, setAllLinks] = useState(false);
  const labels = useMutation({
    mutationFn: fetchCablingLabelsCsv,
    onSuccess: (csv) => {
      saveCsv(LABELS_FILE, csv);
    },
  });
  const data = verification.data;
  const sorted = useMemo(() => (data === undefined ? [] : sortVerdicts(data.cables)), [data]);
  const cables = allCables ? sorted : sorted.slice(0, CABLING.undocumentedRows);
  const links =
    data === undefined
      ? []
      : allLinks
        ? data.undocumented
        : data.undocumented.slice(0, CABLING.undocumentedRows);

  return (
    <Card padding="24" className="flex flex-col gap-om-12">
      <div className="flex flex-col gap-om-12" data-testid="cable-verification">
        <SectionTitle
          as="h2"
          size="sm"
          description={t('dcim.cabling.verify.subtitle')}
          action={
            <Button
              tone="quiet"
              disabled={labels.isPending}
              onClick={() => {
                labels.mutate();
              }}
            >
              {t('dcim.cabling.verify.labels')}
            </Button>
          }
        >
          {t('dcim.cabling.verify.title')}
        </SectionTitle>
        {verification.isPending ? <QueryState status="pending" /> : null}
        {verification.isError ? <QueryState status="error" /> : null}
        {labels.isError ? (
          <p role="alert" className="text-om-xs text-om-state-down">
            {t('common.error')}
          </p>
        ) : null}
        {data !== undefined ? (
          <>
            <div
              className="grid grid-cols-2 gap-om-12 md:grid-cols-5"
              role="group"
              aria-label={t('dcim.cabling.verify.title')}
            >
              <Kpi
                label={t('dcim.cabling.verify.status.verified')}
                value={format.integer(data.summary.verified)}
                unit={t('dcim.cabling.kpi.of', { total: format.integer(data.summary.cables) })}
              />
              <Kpi
                label={t('dcim.cabling.verify.status.mismatch')}
                value={format.integer(data.summary.mismatch)}
              />
              <Kpi
                label={t('dcim.cabling.verify.status.unobserved')}
                value={format.integer(data.summary.unobserved)}
              />
              <Kpi
                label={t('dcim.cabling.verify.status.unverifiable')}
                value={format.integer(data.summary.unverifiable)}
              />
              <Kpi
                label={t('dcim.cabling.verify.undocumented')}
                value={format.integer(data.summary.undocumented)}
              />
            </div>

            {sorted.length === 0 ? (
              <p className="text-om-sm text-om-secondary">{t('dcim.cabling.cables.empty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className={tableClass} aria-label={t('dcim.cabling.verify.cables')}>
                  <thead className={theadClass}>
                    <tr>
                      <th className={thClass}>{t('dcim.cabling.label')}</th>
                      <th className={thClass}>{t('dcim.cabling.verify.verdict')}</th>
                      <th className={thClass}>{t('dcim.cabling.verify.finding')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cables.map((c) => (
                      <tr key={c.cable.ci.id} className={rowClass} data-status={c.status}>
                        <td className={tdClass + ' font-mono text-om-primary'}>{c.cable.label}</td>
                        <td className={tdClass}>
                          <Tag>{t(statusKey(c.status))}</Tag>
                        </td>
                        <td className={tdClass}>
                          {c.status === 'mismatch' && c.observed !== null
                            ? t('dcim.cabling.verify.seenInstead', { link: c.observed.suggestedLabel })
                            : t(reasonKey(c.reason))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {sorted.length > cables.length ? (
              <div>
                <Button
                  tone="quiet"
                  onClick={() => {
                    setAllCables(true);
                  }}
                >
                  {t('dcim.cabling.verify.showAll', { count: format.integer(sorted.length) })}
                </Button>
              </div>
            ) : null}

            <SectionTitle
              as="h3"
              size="sm"
              description={t('dcim.cabling.verify.undocumentedSubtitle', {
                listed: format.integer(data.undocumented.length),
                total: format.integer(data.summary.undocumented),
              })}
            >
              {t('dcim.cabling.verify.undocumentedTitle')}
            </SectionTitle>
            {data.undocumented.length === 0 ? (
              <p className="text-om-sm text-om-secondary">{t('dcim.cabling.verify.undocumentedEmpty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className={tableClass} aria-label={t('dcim.cabling.verify.undocumentedTitle')}>
                  <thead className={theadClass}>
                    <tr>
                      <th className={thClass}>{t('dcim.cabling.verify.link')}</th>
                      <th className={thClass}>{t('dcim.cabling.verify.protocol')}</th>
                      <th className={thClass}>{t('dcim.cabling.verify.speed')}</th>
                      {operator ? <th className={thClass}>{t('dcim.cabling.actions')}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {links.map((l) => (
                      <tr key={l.suggestedLabel + (l.protocol ?? '')} className={rowClass}>
                        <td className={tdClass + ' font-mono text-om-primary'}>{l.suggestedLabel}</td>
                        <td className={tdClass}>{l.protocol ?? ''}</td>
                        <td className={tdClass}>
                          {l.speedMbps === null
                            ? ''
                            : t('dcim.cabling.verify.speedValue', { mbps: format.integer(l.speedMbps) })}
                        </td>
                        {operator ? (
                          <td className={tdClass}>
                            <Button
                              tone="quiet"
                              aria-label={t('dcim.cabling.verify.recordLink', { label: l.suggestedLabel })}
                              onClick={() => {
                                onRecord(l);
                              }}
                            >
                              {t('dcim.cabling.verify.record')}
                            </Button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data.undocumented.length > links.length ? (
              <div>
                <Button
                  tone="quiet"
                  onClick={() => {
                    setAllLinks(true);
                  }}
                >
                  {t('dcim.cabling.verify.showAll', { count: format.integer(data.undocumented.length) })}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Card>
  );
}
