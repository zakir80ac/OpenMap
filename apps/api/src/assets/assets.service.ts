// REQ-CMDB-002 REQ-CMDB-039 REQ-CMDB-040 — asset management use cases: the register with its filters and per-layer
// summary, infrastructure plans (BOM → planned assets in one transaction), plan status, audited stage changes,
// audited detail entry (warranty, support, end of life, purchase, custodian), manual assets for items with no
// network presence (a CI is created with them), and the row an owned CI gets when a person labels it (ADR-023).
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ASSETS, BSM, RECONCILIATION } from '@openmap/constants';
import { CI_TYPE_LAYER, isOwnedCiType, type CiLayer } from '@openmap/contracts';
import type { Prisma } from '@openmap/db';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord } from '../ci/ci.types.js';
import { clampPageSize, decodeIdCursor } from '../common/cursor.js';
import { nowIso } from '../common/time.js';
import { OutboxService, type OutboxDraft } from '../outbox/outbox.service.js';
import { ASSETS_REPOSITORY, type AssetsQuery, type AssetsRepository } from './assets.repository.js';
import type { AssetDetailsInput, AssetFilterInput, ManualAssetInput, PlanInput } from './assets.schemas.js';
import type {
  AssetAuditView,
  AssetPageView,
  AssetRecordView,
  AssetStage,
  AssetSummaryView,
  InfraPlanView,
  PlanStatus,
  SupportContractView,
  VendorContactView,
} from './assets.types.js';

export const PLAN_NUMBER_PREFIX = 'PLAN-';

function horizonIso(days: number | null): string | null {
  return days === null
    ? null
    : new Date(Date.now() + days * BSM.minutesPerDay * BSM.msPerMinute).toISOString();
}

/**
 * REQ-CMDB-019 — the low-stock event of a stocked spare at or below its reorder point; null when the stock is fine
 * or not tracked.
 */
function stockLow(asset: AssetRecordView, actor: string): OutboxDraft | null {
  const stock = asset.stock;
  if (stock === null || !stock.belowReorderPoint) return null;
  return {
    type: 'openmap.asset.stock.low',
    subject: asset.id,
    data: { assetId: asset.id, assetTag: asset.assetTag, onHand: stock.onHand, reorderPoint: stock.reorderPoint, by: actor },
  };
}

@Injectable()
export class AssetsService {
  constructor(
    @Inject(ASSETS_REPOSITORY) private readonly repo: AssetsRepository,
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly outbox: OutboxService,
  ) {}

  assets(
    tenantId: string,
    filter: AssetFilterInput | null,
    stages: readonly AssetStage[],
    warrantyExpiringWithinDays: number | null,
    first: number | null | undefined,
    after: string | null | undefined,
  ): Promise<AssetRecordView[]> {
    const query: AssetsQuery = {
      layers: filter?.layers ?? [],
      types: filter?.types ?? [],
      stages: filter?.stages ?? stages,
      sources: filter?.sources ?? [],
      dataGaps: filter?.dataGaps ?? [],
      text: filter?.text?.trim() || null,
      warrantyEndsBefore: horizonIso(filter?.warrantyExpiringWithinDays ?? warrantyExpiringWithinDays),
      belowReorderPoint: filter?.belowReorderPoint === true,
      first: clampPageSize(first),
      afterId: after ? decodeIdCursor(after).id : null,
    };
    return this.repo.assets(tenantId, query);
  }

  /** REQ-CMDB-041 — a register page by number; the filter is the one `assets` takes, without the cursor. */
  assetPage(
    tenantId: string,
    filter: AssetFilterInput | null,
    page: number | null | undefined,
    pageSize: number | null | undefined,
  ): Promise<AssetPageView> {
    const query: AssetsQuery = {
      layers: filter?.layers ?? [],
      types: filter?.types ?? [],
      stages: filter?.stages ?? [],
      sources: filter?.sources ?? [],
      dataGaps: filter?.dataGaps ?? [],
      text: filter?.text?.trim() || null,
      warrantyEndsBefore: horizonIso(filter?.warrantyExpiringWithinDays ?? null),
      belowReorderPoint: filter?.belowReorderPoint === true,
      first: ASSETS.registerPageSize,
      afterId: null,
    };
    return this.repo.assetPage(tenantId, query, page ?? 1, pageSize ?? ASSETS.registerPageSize);
  }

  summary(tenantId: string): Promise<AssetSummaryView[]> {
    return this.repo.summary(tenantId, nowIso());
  }

  audits(tenantId: string, assetId: string): Promise<AssetAuditView[]> {
    return this.repo.audits(tenantId, assetId);
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
      await emit({
        type: 'openmap.plan.status.changed',
        subject: plan.id,
        data: {
          planId: plan.id,
          number: plan.number,
          status: plan.status,
          previous: null,
          assetIds,
          by: owner,
        },
      });
      for (const assetId of assetIds)
        await emit({
          type: 'openmap.asset.stage.changed',
          subject: assetId,
          data: { assetId, planId: plan.id, stage: 'planned', previous: null, by: owner },
        });
      return plan;
    });
  }

  setPlanStatus(tenantId: string, actor: string, planId: string, status: PlanStatus): Promise<InfraPlanView> {
    return this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const before = await this.repo.plan(tenantId, planId);
      if (!before) throw new NotFoundException('plan ' + planId + ' not found');
      const plan = await this.repo.setPlanStatus(tx, tenantId, planId, status);
      await emit({
        type: 'openmap.plan.status.changed',
        subject: plan.id,
        data: {
          planId: plan.id,
          number: plan.number,
          status: plan.status,
          previous: before.status,
          by: actor,
        },
      });
      return plan;
    });
  }

  setAssetStage(
    tenantId: string,
    actor: string,
    assetId: string,
    stage: AssetStage,
    note: string | null,
  ): Promise<AssetRecordView> {
    return this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const before = await this.repo.asset(tenantId, assetId);
      if (!before) throw new NotFoundException('asset ' + assetId + ' not found');
      const asset = await this.repo.setAssetStage(tx, tenantId, assetId, stage, actor, note, nowIso());
      await emit({
        type: 'openmap.asset.stage.changed',
        subject: asset.id,
        data: {
          assetId: asset.id,
          ciId: asset.ciId,
          stage: asset.stage,
          previous: before.stage,
          note,
          by: actor,
        },
      });
      return asset;
    });
  }

  /** Records what a person knows about an asset; each changed field is an audit row and the event lists them. */
  updateAsset(
    tenantId: string,
    actor: string,
    assetId: string,
    input: AssetDetailsInput,
  ): Promise<AssetRecordView> {
    return this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const before = await this.repo.asset(tenantId, assetId);
      if (!before) throw new NotFoundException('asset ' + assetId + ' not found');
      const { asset, changed } = await this.repo.updateDetails(tx, tenantId, assetId, input, actor, nowIso());
      if (changed.length > 0)
        await emit({
          type: 'openmap.asset.updated',
          subject: asset.id,
          data: { assetId: asset.id, ciId: asset.ciId, changed, dataGaps: asset.dataGaps, by: actor },
        });
      // REQ-CMDB-019: crossing to the reorder point is the moment to reorder; staying below it is not news.
      const low = before.stock?.belowReorderPoint === true ? null : stockLow(asset, actor);
      if (low !== null) await emit(low);
      return asset;
    });
  }

  /**
   * A manual asset for something discovery cannot see: the CI is created first (through the outbox like any CI, so
   * the graph and the search index carry it), then its register row with the entered details.
   */
  createAsset(tenantId: string, actor: string, input: ManualAssetInput): Promise<AssetRecordView> {
    return this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const serial = input.details.serialNumber ?? null;
      const ci = await this.cis.create(tx, tenantId, {
        type: input.type,
        identity: serial === null ? { name: input.name } : { serialNumber: serial },
        name: input.name,
        attributes: {
          ...(input.details.manufacturer ? { manufacturer: input.details.manufacturer } : {}),
          ...(input.details.model ? { model: input.details.model } : {}),
          ...(serial === null ? {} : { serialNumber: serial }),
          ...(input.assetTag ? { assetTag: input.assetTag } : {}),
          entryMethod: 'manual',
          enteredBy: actor,
        },
        tags: ['manual'],
        lifecycle: 'managed',
        // Run ids are UUIDs everywhere (ClickHouse ci_history types the column so); a manual entry is its own run.
        runId: randomUUID(),
        confidence: RECONCILIATION.userLabelConfidence,
      });
      await emit({ type: 'openmap.ci.created', subject: ci.id, data: { ci } });
      const asset = await this.repo.createManual(tx, tenantId, actor, ci, input, nowIso());
      await emit({
        type: 'openmap.asset.created',
        subject: asset.id,
        data: {
          assetId: asset.id,
          ciId: ci.id,
          source: 'manual',
          layer: asset.layer,
          dataGaps: asset.dataGaps,
          by: actor,
        },
      });
      const low = stockLow(asset, actor);
      if (low !== null) await emit(low);
      return asset;
    });
  }

  /**
   * Called when a person labels a CI (an unknown device classified into an owned type, or a layer override): the CI
   * gets its register row if it has none yet. Labelling into a non-owned type leaves the register alone.
   */
  async ensureForLabelledCi(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: string,
    ci: CiRecord,
    layer: CiLayer,
  ): Promise<AssetRecordView | null> {
    if (!isOwnedCiType(ci.type)) return null;
    return this.repo.ensureForCi(tx, tenantId, actor, ci, layer ?? CI_TYPE_LAYER[ci.type], nowIso());
  }
}
