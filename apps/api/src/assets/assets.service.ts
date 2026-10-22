// REQ-CMDB-002 — asset management use cases: listing, infrastructure plans (BOM → planned assets in
// one transaction), plan status and audited asset stage changes.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { BSM } from '@openmap/constants';
import { clampPageSize, decodeCursor } from '../common/cursor.js';
import { nowIso } from '../common/time.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { ASSETS_REPOSITORY, type AssetsRepository } from './assets.repository.js';
import type { PlanInput } from './assets.schemas.js';
import type { AssetRecordView, AssetStage, InfraPlanView, PlanStatus, SupportContractView, VendorContactView } from './assets.types.js';

export const PLAN_NUMBER_PREFIX = 'PLAN-';

@Injectable()
export class AssetsService {
  constructor(
    @Inject(ASSETS_REPOSITORY) private readonly repo: AssetsRepository,
    private readonly outbox: OutboxService,
  ) {}

  assets(tenantId: string, stages: readonly AssetStage[], warrantyExpiringWithinDays: number | null, first: number | null | undefined, after: string | null | undefined): Promise<AssetRecordView[]> {
    const warrantyEndsBefore = warrantyExpiringWithinDays === null ? null : new Date(Date.now() + warrantyExpiringWithinDays * BSM.minutesPerDay * BSM.msPerMinute).toISOString();
    return this.repo.assets(tenantId, { stages, warrantyEndsBefore, first: clampPageSize(first), afterId: after ? decodeCursor(after).id : null });
  }

  assetsByCiIds(tenantId: string, ciIds: readonly string[]): Promise<AssetRecordView[]> {
    return this.repo.assetsByCiIds(tenantId, ciIds);
  }

  assetsByPlan(tenantId: string, planId: string): Promise<AssetRecordView[]> {
    return this.repo.assetsByPlan(tenantId, planId);
  }

  plans(tenantId: string, statuses: readonly PlanStatus[]): Promise<InfraPlanView[]> {
    return this.repo.plans(tenantId, statuses);
  }

  plan(tenantId: string, id: string): Promise<InfraPlanView | null> {
    return this.repo.plan(tenantId, id);
  }

  supportContract(tenantId: string, id: string): Promise<SupportContractView | null> {
    return this.repo.supportContract(tenantId, id);
  }

  vendorContact(tenantId: string, id: string): Promise<VendorContactView | null> {
    return this.repo.vendorContact(tenantId, id);
  }

  createPlan(tenantId: string, owner: string, input: PlanInput): Promise<InfraPlanView> {
    return this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const number = PLAN_NUMBER_PREFIX + String((await this.repo.planCount(tx, tenantId)) + 1);
      const { plan, assetIds } = await this.repo.createPlan(tx, tenantId, owner, number, input);
      await emit({ type: 'openmap.plan.status.changed', subject: plan.id, data: { planId: plan.id, number: plan.number, status: plan.status, previous: null, assetIds, by: owner } });
      for (const assetId of assetIds) await emit({ type: 'openmap.asset.stage.changed', subject: assetId, data: { assetId, planId: plan.id, stage: 'planned', previous: null, by: owner } });
      return plan;
    });
  }

  setPlanStatus(tenantId: string, actor: string, planId: string, status: PlanStatus): Promise<InfraPlanView> {
    return this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const before = await this.repo.plan(tenantId, planId);
      if (!before) throw new NotFoundException('plan ' + planId + ' not found');
      const plan = await this.repo.setPlanStatus(tx, tenantId, planId, status);
      await emit({ type: 'openmap.plan.status.changed', subject: plan.id, data: { planId: plan.id, number: plan.number, status: plan.status, previous: before.status, by: actor } });
      return plan;
    });
  }

  setAssetStage(tenantId: string, actor: string, assetId: string, stage: AssetStage, note: string | null): Promise<AssetRecordView> {
    return this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const before = await this.repo.asset(tenantId, assetId);
      if (!before) throw new NotFoundException('asset ' + assetId + ' not found');
      const asset = await this.repo.setAssetStage(tx, tenantId, assetId, stage, actor, note, nowIso());
      await emit({ type: 'openmap.asset.stage.changed', subject: asset.id, data: { assetId: asset.id, ciId: asset.ciId, stage: asset.stage, previous: before.stage, note, by: actor } });
      return asset;
    });
  }
}
