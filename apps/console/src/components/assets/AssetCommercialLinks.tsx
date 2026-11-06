'use client';
// REQ-CMDB-026 REQ-CMDB-028 (ADR-035) — on an asset's details panel: the contract that covers it (its vendor and first
// escalation contact) and the cost centre that owns it. Operators choose either from the commercial register; the
// contract goes through setAssetContract (which links the asset's CI covered_by the contract), the owner through
// updateAsset.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, type ReactNode } from 'react';
import { Field, Select } from '@/components/common/controls';
import { contractsQuery, costCentresQuery, setAssetContract } from '@/lib/commercial-queries';
import { updateAsset, type AssetRecord } from '@/lib/estate-queries';
import { useT } from '@/providers';

export interface AssetCommercialLinksProps {
  asset: AssetRecord;
  canEdit: boolean;
}

export function AssetCommercialLinks({ asset, canEdit }: AssetCommercialLinksProps): ReactNode {
  const t = useT();
  const id = useId();
  const queryClient = useQueryClient();
  const editable = canEdit && asset.ci !== null;
  const contracts = useQuery({ ...contractsQuery({}), enabled: editable });
  const centres = useQuery({ ...costCentresQuery(), enabled: editable });
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['assets'] });
    await queryClient.invalidateQueries({ queryKey: ['assetSummary'] });
    await queryClient.invalidateQueries({ queryKey: ['assetAudits', asset.assetTag] });
    await queryClient.invalidateQueries({ queryKey: ['contracts'] });
    await queryClient.invalidateQueries({ queryKey: ['costCentres'] });
  };
  const contract = useMutation({ mutationFn: (contractId: string | null) => setAssetContract(asset.id, contractId), onSuccess: refresh });
  const owner = useMutation({ mutationFn: (centreId: string | null) => updateAsset(asset.id, { ownerCostCentreId: centreId }), onSuccess: refresh });
  const support = asset.supportContract;
  const failed = contract.error ?? owner.error;

  return (
    <div className="flex flex-col gap-om-8 rounded-om-panel border border-om-border-glass bg-om-surface2/60 px-om-12 py-om-10" data-testid="asset-commercial">
      <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('commercial.asset.title')}</span>
      <p className="text-om-xs text-om-secondary">
        {support === null
          ? t('commercial.asset.noContract')
          : t('commercial.asset.coveredBy', { number: support.contractNumber, vendor: support.vendor.displayName })}
        {support?.primaryContact ? ' · ' + t('commercial.asset.firstCall', { name: support.primaryContact.name }) : ''}
      </p>
      <p className="text-om-xs text-om-secondary">
        {asset.ownerCostCentre === null ? t('commercial.asset.noOwner') : t('commercial.asset.ownedBy', { name: asset.ownerCostCentre.displayName })}
      </p>
      {editable ? (
        <div className="grid grid-cols-1 gap-om-10 md:grid-cols-2">
          <Field id={id + '-contract'} label={t('commercial.asset.contract')}>
            <Select
              id={id + '-contract'}
              value={support?.id ?? ''}
              disabled={contract.isPending}
              onChange={(event) => {
                contract.mutate(event.target.value === '' ? null : event.target.value);
              }}
            >
              <option value="">{t('common.none')}</option>
              {(contracts.data ?? []).map((c) => (
                <option key={c.ci.id} value={c.ci.id}>
                  {c.contractNumber + ' · ' + c.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={id + '-owner'} label={t('commercial.asset.owner')}>
            <Select
              id={id + '-owner'}
              value={asset.ownerCostCentre?.id ?? ''}
              disabled={owner.isPending}
              onChange={(event) => {
                owner.mutate(event.target.value === '' ? null : event.target.value);
              }}
            >
              <option value="">{t('common.none')}</option>
              {(centres.data ?? []).map((c) => (
                <option key={c.ci.id} value={c.ci.id}>
                  {c.code + ' · ' + c.ci.displayName}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ) : canEdit ? (
        <p className="text-om-2xs text-om-muted">{t('commercial.asset.needsCi')}</p>
      ) : null}
      {failed instanceof Error ? (
        <span role="alert" className="text-om-xs text-om-state-down">
          {failed.message}
        </span>
      ) : null}
    </div>
  );
}
