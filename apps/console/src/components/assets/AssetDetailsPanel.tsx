'use client';
// REQ-CMDB-039 — the edit panel of a register row (ADR-023): what discovery or a person recorded, the cover dates
// with their source, the audit trail, and the details form whose save goes through updateAsset.
// REQ-CMDB-026 REQ-CMDB-028 — the covering contract and the owning cost centre (ADR-035).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isSubscriptionCiType } from '@openmap/contracts';
import { LayerBadge, SectionTitle, Tag } from '@openmap/ui';
import type { ReactNode } from 'react';
import { Button } from '@/components/common/controls';
import { Icon } from '@/components/icons';
import {
  assetAuditsQuery,
  updateAsset,
  type AssetDetailsInput,
  type AssetRecord,
} from '@/lib/estate-queries';
import { useFormatters, useT } from '@/providers';
import { AssetCommercialLinks } from './AssetCommercialLinks';
import { AssetDetailsForm } from './AssetDetailsForm';

export interface AssetDetailsPanelProps {
  asset: AssetRecord;
  canEdit: boolean;
  onClose: () => void;
  /** The row as the server returned it after a save. */
  onSaved?: (asset: AssetRecord) => void;
}

type SourceKey =
  | 'assets.details.source.vendor_api'
  | 'assets.details.source.purchase_record'
  | 'assets.details.source.manual';

function sourceKey(source: string): SourceKey {
  if (source === 'vendor_api') return 'assets.details.source.vendor_api';
  if (source === 'purchase_record') return 'assets.details.source.purchase_record';
  return 'assets.details.source.manual';
}

export function AssetDetailsPanel({ asset, canEdit, onClose, onSaved }: AssetDetailsPanelProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const queryClient = useQueryClient();
  const audits = useQuery(assetAuditsQuery(asset.assetTag));
  const mutation = useMutation({
    mutationFn: (input: AssetDetailsInput) => updateAsset(asset.id, input),
    onSuccess: async (saved) => {
      onSaved?.(saved);
      await queryClient.invalidateQueries({ queryKey: ['assets'] });
      await queryClient.invalidateQueries({ queryKey: ['assetSummary'] });
      await queryClient.invalidateQueries({ queryKey: ['assetAudits', asset.assetTag] });
    },
  });
  const cover = (
    label: string,
    endsAt: string | null,
    source: string | null,
    note: string | null = null,
  ): ReactNode => (
    <div className="flex flex-col gap-om-2 rounded-om-panel border border-om-border-glass bg-om-surface2/60 px-om-12 py-om-8">
      <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{label}</span>
      <span className="font-om-mono text-om-sm tabular-nums text-om-primary">
        {endsAt === null ? (note === null ? t('assets.table.missing') : note) : format.date(endsAt)}
      </span>
      {endsAt !== null && note !== null ? (
        <span className="text-om-2xs text-om-secondary">{note}</span>
      ) : null}
      {source !== null ? <span className="text-om-2xs text-om-secondary">{t(sourceKey(source))}</span> : null}
    </div>
  );
  const subscriptionType = isSubscriptionCiType(asset.ciType);
  const credits = asset.subscription?.credits ?? null;
  const creditsNote =
    credits === null
      ? null
      : t('assets.table.credits', {
          remaining: format.number(credits.remaining),
          unit: credits.currency ?? credits.unit,
        });
  return (
    <section
      aria-label={t('assets.details.title')}
      data-testid="asset-details-panel"
      className="flex flex-col gap-om-14 rounded-om-panel border border-om-violet/30 bg-om-surface1 p-om-16"
    >
      <SectionTitle
        as="h3"
        size="sm"
        description={t('assets.details.hint')}
        action={
          <Button tone="quiet" onClick={onClose} aria-label={t('assets.details.close')}>
            <Icon name="close" className="size-4" />
          </Button>
        }
      >
        <span className="font-om-mono">{asset.assetTag}</span>
        <span className="ms-om-8 text-om-secondary">
          {[asset.manufacturer, asset.model].filter((v) => v !== null).join(' ')}
        </span>
      </SectionTitle>
      <div className="flex flex-wrap items-center gap-om-8">
        <LayerBadge layer={asset.layer} label={t(`layer.${asset.layer}`)} />
        {asset.ciType !== null ? <Tag>{asset.ciType}</Tag> : null}
        <Tag>{t(`assets.source.${asset.source}`)}</Tag>
        {asset.ci !== null ? (
          <span className="text-om-xs text-om-secondary">{asset.ci.displayName}</span>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-om-8 md:grid-cols-3">
        {subscriptionType
          ? cover(
              t('assets.details.subscription.title'),
              asset.subscription?.endsAt ?? null,
              asset.subscription?.source ?? null,
              creditsNote,
            )
          : cover(
              t('assets.details.warranty.title'),
              asset.warranty?.endsAt ?? null,
              asset.warranty?.source ?? null,
            )}
        {cover(
          t('assets.details.support.title'),
          asset.support?.endsAt ?? asset.supportContract?.endsAt ?? null,
          asset.support?.source ?? null,
        )}
        {cover(
          t('assets.details.eol.title'),
          asset.endOfLife?.endOfSupport ?? null,
          asset.endOfLife?.source ?? null,
        )}
      </div>
      <AssetCommercialLinks asset={asset} canEdit={canEdit} />
      {canEdit ? (
        <AssetDetailsForm
          initial={asset}
          label={t('assets.details.title')}
          submitLabel={t('assets.details.save')}
          pending={mutation.isPending}
          onSubmit={(details) => {
            mutation.mutate(details);
          }}
          status={
            mutation.isSuccess ? (
              <span role="status" className="text-om-xs text-om-state-healthy">
                {t('assets.details.saved')}
              </span>
            ) : mutation.isError ? (
              <span role="alert" className="text-om-xs text-om-state-down">
                {t('assets.details.error')}
              </span>
            ) : null
          }
        />
      ) : null}
      <div className="flex flex-col gap-om-6">
        <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
          {t('assets.details.audits.title')}
        </span>
        {audits.data === undefined || audits.data.length === 0 ? (
          <p className="text-om-xs text-om-secondary">{t('assets.details.audits.empty')}</p>
        ) : (
          <ul className="flex max-h-40 flex-col gap-om-4 overflow-y-auto text-om-xs">
            {audits.data.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline gap-om-6">
                <span className="font-om-mono text-om-2xs text-om-muted">{format.dateTime(entry.at)}</span>
                <span className="text-om-secondary">
                  {t('assets.details.audits.entry', { actor: entry.actor, field: entry.field })}
                </span>
                {entry.toValue !== null ? (
                  <span className="truncate font-om-mono text-om-2xs text-om-primary">{entry.toValue}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
