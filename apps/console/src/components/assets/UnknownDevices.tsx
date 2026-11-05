'use client';
// REQ-CMDB-040 — the unknown layer on the Assets screen (ADR-023): every device discovery could not classify, with
// its diagnosis (why it is unknown, what the scanners saw, where it belongs) and the remediation: a collector scope,
// a credential, or classifying it here, which creates its register row for manual cover entry.
import { useQuery } from '@tanstack/react-query';
import { ASSETS } from '@openmap/constants';
import { Card, LayerBadge, SectionTitle, Tag } from '@openmap/ui';
import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { LabelCiPanel } from '@/components/cmdb/LabelCiPanel';
import { unknownCisQuery, type UnknownCi } from '@/lib/estate-queries';
import { layerKey } from '@/lib/keys';
import { localizedHref } from '@/lib/locale-path';
import { diagnoseUnknown, type Remediation } from '@/lib/unknown-remediation';
import { useFormatters, useLocale, useT } from '@/providers';

export interface UnknownDevicesProps {
  canOperate: boolean;
}

function kindTitle(t: ReturnType<typeof useT>, r: Remediation): string {
  return r.kind === 'unknown_service' ? t('assets.unknown.kind.unknown_service.title', { ports: r.nonStandardPorts.join(', ') }) : t(`assets.unknown.kind.${r.kind}.title`);
}

export function UnknownDevices({ canOperate }: UnknownDevicesProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const locale = useLocale();
  const unknown = useQuery(unknownCisQuery());
  const [open, setOpen] = useState<string | null>(null);
  const [classified, setClassified] = useState<string | null>(null);
  const now = useMemo(() => new Date(), []);
  const rows = useMemo(() => (unknown.data?.items ?? []).map((ci) => ({ ci, remediation: diagnoseUnknown(ci.attributes, now) })), [unknown.data, now]);
  const evidenceValue = (key: Remediation['evidence'][number]['key'], value: string): string => {
    if (key === 'lastSeen') return format.dateTime(value);
    if (key === 'snmp') return value === 'yes' ? t('common.yes') : t('common.no');
    return value;
  };
  const row = (ci: UnknownCi, r: Remediation): ReactNode => (
    <li key={ci.id} data-testid="unknown-device" data-kind={r.kind} data-stale={r.stale ? 'true' : undefined} className="flex flex-col gap-om-8 rounded-om-panel border border-om-border-glass bg-om-surface2/50 px-om-14 py-om-10">
      <div className="flex flex-wrap items-center gap-om-8">
        <Link href={localizedHref(locale, '/cmdb/' + encodeURIComponent(ci.id))} className="font-om-display text-om-sm font-semibold text-om-primary hover:underline">
          {ci.displayName}
        </Link>
        <Tag variant="state" state={r.manageable ? 'at_risk' : 'down'}>
          {kindTitle(t, r)}
        </Tag>
        {r.stale ? (
          <Tag variant="state" state="unknown">
            {t('assets.unknown.stale.title', { days: format.integer(ASSETS.unknownStaleDays) })}
          </Tag>
        ) : null}
        {r.manageable ? null : <Tag>{t('assets.unknown.manualOnly')}</Tag>}
        <span className="ms-auto flex items-center gap-om-6 text-om-2xs text-om-secondary">
          <LayerBadge layer={r.suggestedLayer} label={t(layerKey(r.suggestedLayer))} />
          <span className="font-om-mono">{r.suggestedType}</span>
        </span>
      </div>
      <p className="text-om-xs text-om-secondary">
        {r.stale ? t('assets.unknown.stale.action') + ' ' : null}
        {t(`assets.unknown.kind.${r.kind}.action`)}
      </p>
      <dl className="grid grid-cols-1 gap-x-om-12 gap-y-om-2 text-om-2xs md:grid-cols-2">
        {r.evidence.map((e) => (
          <div key={e.key} className="flex gap-om-6">
            <dt className="shrink-0 text-om-muted">{t(`assets.unknown.evidence.${e.key}`)}</dt>
            <dd className="truncate font-om-mono text-om-secondary" title={e.value}>
              {evidenceValue(e.key, e.value)}
            </dd>
          </div>
        ))}
      </dl>
      {canOperate ? (
        <div className="flex flex-wrap items-center gap-om-8">
          <Button
            tone={open === ci.id ? 'quiet' : 'primary'}
            onClick={() => {
              setOpen((current) => (current === ci.id ? null : ci.id));
            }}
            aria-expanded={open === ci.id}
            aria-controls={'label-' + ci.id}
          >
            {open === ci.id ? t('assets.unknown.close') : t('cmdb.detail.label.title')}
          </Button>
          {classified === ci.id ? (
            <span role="status" className="text-om-xs text-om-state-healthy">
              {t('assets.unknown.classified', { name: ci.displayName })}
            </span>
          ) : null}
        </div>
      ) : null}
      {open === ci.id ? (
        <div id={'label-' + ci.id}>
          <LabelCiPanel
          ci={{ id: ci.id, displayName: ci.displayName, userLabel: null }}
          preset={{ layer: r.suggestedLayer, type: r.suggestedType }}
          onLabelled={() => {
            setClassified(ci.id);
            setOpen(null);
          }}
          />
        </div>
      ) : null}
    </li>
  );
  return (
    <Card as="section" padding="24" className="flex flex-col gap-om-14">
      <SectionTitle as="h2" size="sm" description={t('assets.unknown.subtitle')} action={unknown.data !== undefined ? <Tag>{t('assets.unknown.count', { count: format.integer(unknown.data.total) })}</Tag> : undefined}>
        {t('assets.unknown.title')}
      </SectionTitle>
      {unknown.isPending ? (
        <QueryState status="pending" />
      ) : unknown.isError ? (
        <QueryState
          status="error"
          onRetry={() => {
            void unknown.refetch();
          }}
        />
      ) : rows.length === 0 ? (
        <p className="text-om-sm text-om-secondary">{t('assets.unknown.empty')}</p>
      ) : (
        <ul className="flex max-h-[32rem] flex-col gap-om-8 overflow-y-auto" data-testid="unknown-devices">
          {rows.map(({ ci, remediation }) => row(ci, remediation))}
        </ul>
      )}
    </Card>
  );
}
