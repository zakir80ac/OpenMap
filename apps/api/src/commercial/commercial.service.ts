// REQ-CMDB-026 REQ-CMDB-027 REQ-CMDB-028 REQ-CMDB-029 (ADR-035) — the commercial register over CIs: contracts with
// their vendor (supported_by), cost centre (billed_to), covered assets (covered_by), renewal dates and documents;
// vendors with contracts, coverage, cost and contacts in escalation order; cost centres with budget, contract cost and
// the assets and plans they own. People create and edit vendors, contracts and cost centres as CIs through the outbox
// (so the graph, search and history follow) and link an asset to the contract that covers it.
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { RECONCILIATION } from '@openmap/constants';
import {
  CONTRACT_ATTRIBUTES,
  contractDocuments,
  contractKindOf,
  costCentreKindSchema,
  daysToEnd,
  noticeBy,
  type ContractInput,
  type CostCentreInput,
  type CiType,
  type RelationshipType,
  type VendorInput,
} from '@openmap/contracts';
import type { Prisma } from '@openmap/db';
import { AssetsService } from '../assets/assets.service.js';
import type { AssetRecordView } from '../assets/assets.types.js';
import { checksumOf } from '../ci/checksum.js';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord, RelationshipRecord } from '../ci/ci.types.js';
import { toMoney, type Money } from '../common/money.js';
import { nowIso } from '../common/time.js';
import { booleanAttribute, isoAttribute, numberAttribute, stringAttribute } from '../common/validation.js';
import { PrismaService } from '../db/prisma.service.js';
import { OutboxService, type OutboxDraft } from '../outbox/outbox.service.js';
import type {
  ContractFilter,
  ContractView,
  CostCentreView,
  VendorContactView,
  VendorDetailView,
  VendorView,
} from './commercial.types.js';
import type { VendorContactInput } from './commercial.schemas.js';

export const SUPPORTED_BY: RelationshipType = 'supported_by';
export const BILLED_TO: RelationshipType = 'billed_to';
export const COVERED_BY: RelationshipType = 'covered_by';
const DAY_LENGTH = 'YYYY-MM-DD'.length;

type Emit = (draft: OutboxDraft) => Promise<unknown>;

/** A calendar day as the DateTime scalar's instant (midnight UTC). */
function dayInstant(day: string | null): string | null {
  return day === null ? null : new Date(day.slice(0, DAY_LENGTH) + 'T00:00:00Z').toISOString();
}

/** Sum of amounts that share one currency; null when there are none or they are in several currencies. */
export function sumMoney(values: ReadonlyArray<Money | null>): Money | null {
  const priced = values.filter((v): v is Money => v !== null);
  const [firstValue] = priced;
  if (firstValue === undefined || priced.some((v) => v.currency !== firstValue.currency)) return null;
  return { amount: priced.reduce((total, v) => total + v.amount, 0), currency: firstValue.currency };
}

export function toContractView(
  ci: CiRecord,
  links: { vendorCiId: string | null; costCentreCiId: string | null; coveredAssets: number },
  today: string,
): ContractView {
  const a = ci.attributes;
  const endsAt = isoAttribute(a, CONTRACT_ATTRIBUTES.endsAt);
  const days = endsAt === null ? null : daysToEnd(endsAt, today);
  const noticeDays = numberAttribute(a, CONTRACT_ATTRIBUTES.noticeDays);
  return {
    ci,
    kind: contractKindOf(a),
    contractNumber:
      stringAttribute(ci.identity, CONTRACT_ATTRIBUTES.contractNumber) ??
      stringAttribute(a, CONTRACT_ATTRIBUTES.contractNumber) ??
      ci.name,
    title: stringAttribute(a, CONTRACT_ATTRIBUTES.title) ?? ci.displayName,
    level: stringAttribute(a, CONTRACT_ATTRIBUTES.level),
    responseMinutes: numberAttribute(a, CONTRACT_ATTRIBUTES.responseMinutes),
    startsAt: isoAttribute(a, CONTRACT_ATTRIBUTES.startsAt),
    endsAt,
    daysToEnd: days,
    noticeDays,
    noticeBy: endsAt === null ? null : dayInstant(noticeBy(endsAt, noticeDays)),
    autoRenews: booleanAttribute(a, CONTRACT_ATTRIBUTES.autoRenews) ?? false,
    expired: days !== null && days < 0,
    annualCost: toMoney(numberAttribute(a, CONTRACT_ATTRIBUTES.annualCost), stringAttribute(a, CONTRACT_ATTRIBUTES.currency)),
    coveredAssets: links.coveredAssets,
    vendorCiId: links.vendorCiId,
    costCentreCiId: links.costCentreCiId,
    documents: contractDocuments(a[CONTRACT_ATTRIBUTES.documents]),
  };
}

function matchesText(view: ContractView, text: string | null): boolean {
  if (text === null || text.trim() === '') return true;
  const needle = text.trim().toLowerCase();
  return [view.title, view.contractNumber, view.ci.displayName, stringAttribute(view.ci.identity, CONTRACT_ATTRIBUTES.vendorRef) ?? '']
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

function byEnd(a: ContractView, b: ContractView): number {
  if (a.endsAt === b.endsAt) return a.title.localeCompare(b.title);
  if (a.endsAt === null) return 1;
  if (b.endsAt === null) return -1;
  return a.endsAt.localeCompare(b.endsAt);
}

interface Links {
  vendorOf: Map<string, string>;
  costCentreOf: Map<string, string>;
  covered: Map<string, number>;
}

@Injectable()
export class CommercialService {
  constructor(
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly outbox: OutboxService,
    private readonly prisma: PrismaService,
    private readonly assets: AssetsService,
  ) {}

  /** Vendor, cost centre and covered-asset count of every contract, from the current relationships. */
  private async links(tenantId: string, contractIds: ReadonlySet<string>): Promise<Links> {
    const [supportedBy, billedTo, coveredBy] = await Promise.all([
      this.cis.relationshipsByType(tenantId, SUPPORTED_BY),
      this.cis.relationshipsByType(tenantId, BILLED_TO),
      this.cis.relationshipsByType(tenantId, COVERED_BY),
    ]);
    const vendorOf = new Map<string, string>();
    for (const r of supportedBy) if (contractIds.has(r.fromCiId) && !vendorOf.has(r.fromCiId)) vendorOf.set(r.fromCiId, r.toCiId);
    const costCentreOf = new Map<string, string>();
    for (const r of billedTo) if (contractIds.has(r.fromCiId) && !costCentreOf.has(r.fromCiId)) costCentreOf.set(r.fromCiId, r.toCiId);
    const covered = new Map<string, number>();
    for (const r of coveredBy) if (contractIds.has(r.toCiId)) covered.set(r.toCiId, (covered.get(r.toCiId) ?? 0) + 1);
    return { vendorOf, costCentreOf, covered };
  }

  private async allContracts(tenantId: string, today: string): Promise<ContractView[]> {
    const cis = await this.cis.byType(tenantId, 'contract');
    const links = await this.links(tenantId, new Set(cis.map((c) => c.id)));
    return cis.map((ci) =>
      toContractView(
        ci,
        {
          vendorCiId: links.vendorOf.get(ci.id) ?? null,
          costCentreCiId: links.costCentreOf.get(ci.id) ?? null,
          coveredAssets: links.covered.get(ci.id) ?? 0,
        },
        today,
      ),
    );
  }

  async contracts(tenantId: string, filter: ContractFilter): Promise<ContractView[]> {
    const views = await this.allContracts(tenantId, nowIso());
    return views
      .filter((v) => filter.kinds.length === 0 || filter.kinds.includes(v.kind))
      .filter((v) => filter.vendorId === null || v.vendorCiId === filter.vendorId)
      .filter((v) => filter.costCentreId === null || v.costCentreCiId === filter.costCentreId)
      .filter((v) => filter.expired === null || v.expired === filter.expired)
      .filter(
        (v) =>
          filter.expiringWithinDays === null ||
          (v.daysToEnd !== null && v.daysToEnd >= 0 && v.daysToEnd <= filter.expiringWithinDays),
      )
      .filter((v) => matchesText(v, filter.text))
      .sort(byEnd);
  }

  async contract(tenantId: string, id: string): Promise<ContractView | null> {
    const views = await this.allContracts(tenantId, nowIso());
    return views.find((v) => v.ci.id === id) ?? null;
  }

  private async contactCounts(tenantId: string): Promise<Map<string, number>> {
    const rows = await this.prisma.client.vendorContact.groupBy({ by: ['vendorCiId'], where: { tenantId }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.vendorCiId, r._count._all]));
  }

  private toVendor(ci: CiRecord, contracts: readonly ContractView[], contacts: number): VendorView {
    const mine = contracts.filter((c) => c.vendorCiId === ci.id);
    const active = mine.filter((c) => !c.expired);
    return {
      ci,
      category: stringAttribute(ci.attributes, 'category'),
      supportPortal: stringAttribute(ci.attributes, 'supportPortal'),
      accountManager: stringAttribute(ci.attributes, 'accountManager'),
      contracts: mine.length,
      activeContracts: active.length,
      coveredAssets: active.reduce((total, c) => total + c.coveredAssets, 0),
      annualCost: sumMoney(active.map((c) => c.annualCost)),
      contacts,
    };
  }

  async vendors(tenantId: string, text: string | null): Promise<VendorView[]> {
    const [vendors, contracts, contacts] = await Promise.all([
      this.cis.byType(tenantId, 'vendor'),
      this.allContracts(tenantId, nowIso()),
      this.contactCounts(tenantId),
    ]);
    const needle = text?.trim().toLowerCase() ?? '';
    return vendors
      .filter((v) => needle === '' || (v.displayName + ' ' + (stringAttribute(v.attributes, 'category') ?? '')).toLowerCase().includes(needle))
      .map((v) => this.toVendor(v, contracts, contacts.get(v.id) ?? 0))
      .sort((a, b) => a.ci.displayName.localeCompare(b.ci.displayName));
  }

  async vendor(tenantId: string, id: string): Promise<VendorDetailView | null> {
    const ci = await this.cis.findById(tenantId, id, null);
    if (!ci || ci.type !== 'vendor') return null;
    const [contracts, contacts] = await Promise.all([this.allContracts(tenantId, nowIso()), this.vendorContacts(tenantId, id)]);
    return {
      vendor: this.toVendor(ci, contracts, contacts.length),
      contacts,
      contracts: contracts.filter((c) => c.vendorCiId === id).sort(byEnd),
    };
  }

  async vendorContacts(tenantId: string, vendorCiId: string): Promise<VendorContactView[]> {
    return this.prisma.client.vendorContact.findMany({
      where: { tenantId, vendorCiId },
      orderBy: [{ escalationLevel: 'asc' }, { name: 'asc' }],
      select: { id: true, vendorCiId: true, name: true, role: true, email: true, phone: true, portalUrl: true, availability: true, escalationLevel: true },
    });
  }

  async costCentres(tenantId: string): Promise<CostCentreView[]> {
    const client = this.prisma.client;
    const [centres, contracts, assetRows, planRows] = await Promise.all([
      this.cis.byType(tenantId, 'cost_centre'),
      this.allContracts(tenantId, nowIso()),
      client.assetRecord.groupBy({ by: ['ownerCostCentreCiId'], where: { tenantId, ownerCostCentreCiId: { not: null } }, _count: { _all: true } }),
      client.infraPlan.groupBy({ by: ['costCentreCiId'], where: { tenantId, costCentreCiId: { not: null } }, _count: { _all: true } }),
    ]);
    const assets = new Map(assetRows.map((r) => [r.ownerCostCentreCiId, r._count._all]));
    const plans = new Map(planRows.map((r) => [r.costCentreCiId, r._count._all]));
    return centres
      .map((ci): CostCentreView => {
        const a = ci.attributes;
        const billed = contracts.filter((c) => c.costCentreCiId === ci.id);
        const kind = costCentreKindSchema.safeParse(a['kind']);
        return {
          ci,
          code: stringAttribute(ci.identity, 'code') ?? stringAttribute(a, 'code') ?? ci.name,
          kind: kind.success ? kind.data : 'cost_centre',
          owner: stringAttribute(a, 'owner'),
          annualBudget: toMoney(numberAttribute(a, 'annualBudget'), stringAttribute(a, 'currency')),
          contracts: billed.length,
          annualContractCost: sumMoney(billed.filter((c) => !c.expired).map((c) => c.annualCost)),
          assets: assets.get(ci.id) ?? 0,
          plans: plans.get(ci.id) ?? 0,
        };
      })
      .sort((x, y) => x.code.localeCompare(y.code));
  }

  private async requireCi(tenantId: string, id: string, type: CiType): Promise<CiRecord> {
    const ci = await this.cis.findById(tenantId, id, null);
    if (!ci || ci.type !== type || ci.validTo !== null) throw new NotFoundException(type + ' ' + id + ' not found');
    return ci;
  }

  /**
   * Creates the CI, or updates its attributes when `id` names one; the identity keys cannot change (they are what
   * discovery and imports match on), so an update that changes them is refused.
   */
  private async upsertCi(
    tx: Prisma.TransactionClient,
    emit: Emit,
    tenantId: string,
    actor: string,
    id: string | null,
    draft: { type: CiType; identity: Record<string, string>; name: string; attributes: Record<string, unknown> },
  ): Promise<CiRecord> {
    if (id === null) {
      const taken = await this.cis.findCurrentByIdentity(tenantId, draft.type, draft.identity);
      if (taken) throw new ConflictException(draft.type + ' ' + Object.values(draft.identity).join(' / ') + ' already exists');
      const ci = await this.cis.create(tx, tenantId, {
        type: draft.type,
        identity: draft.identity,
        name: draft.name,
        attributes: { ...draft.attributes, entryMethod: 'manual', enteredBy: actor },
        tags: [],
        lifecycle: 'managed',
        // Run ids are UUIDs everywhere (ClickHouse types the column so); a person's entry is its own run.
        runId: randomUUID(),
        confidence: RECONCILIATION.userLabelConfidence,
      });
      await emit({ type: 'openmap.ci.created', subject: ci.id, data: { ci } });
      return ci;
    }
    const current = await this.requireCi(tenantId, id, draft.type);
    const sameIdentity = Object.entries(draft.identity).every(([k, v]) => stringAttribute(current.identity, k) === v);
    if (!sameIdentity) throw new BadRequestException(Object.keys(draft.identity).join(' and ') + ' identify the ' + draft.type + ' and cannot change');
    const merged = { ...current.attributes, ...draft.attributes };
    const ci = await this.cis.updateAttributes(tx, tenantId, id, merged, checksumOf(current.type, current.identity, merged));
    await emit({
      type: 'openmap.ci.updated',
      subject: ci.id,
      data: { ci, ciId: ci.id, changed: Object.keys(draft.attributes), attributes: ci.attributes, checksum: ci.checksum, by: actor },
    });
    return ci;
  }

  /** Makes `target` the only current `type` relationship from `fromCiId` (none when null). */
  private async setOnlyLink(
    tx: Prisma.TransactionClient,
    emit: Emit,
    tenantId: string,
    actor: string,
    fromCiId: string,
    type: RelationshipType,
    target: string | null,
  ): Promise<void> {
    const current = await this.cis.relationshipsOfMany(tenantId, [fromCiId], [type], 'downstream');
    const at = nowIso();
    for (const rel of current.filter((r) => r.toCiId !== target)) {
      const retired = await this.cis.retireRelationship(tx, tenantId, rel.id, at);
      await emit({ type: 'openmap.relationship.retired', subject: retired.id, data: { relationshipId: retired.id, validTo: retired.validTo, by: actor } });
    }
    if (target !== null && !current.some((r) => r.toCiId === target)) await this.link(tx, emit, tenantId, actor, type, fromCiId, target);
  }

  private async link(
    tx: Prisma.TransactionClient,
    emit: Emit,
    tenantId: string,
    actor: string,
    type: RelationshipType,
    fromCiId: string,
    toCiId: string,
  ): Promise<RelationshipRecord> {
    const rel = await this.cis.createRelationship(tx, tenantId, {
      type,
      fromCiId,
      toCiId,
      attributes: {},
      runId: randomUUID(),
      confidence: RECONCILIATION.userLabelConfidence,
    });
    await emit({ type: 'openmap.relationship.created', subject: rel.id, data: { relationship: rel, by: actor } });
    return rel;
  }

  async upsertContract(tenantId: string, actor: string, id: string | null, input: ContractInput): Promise<ContractView> {
    const vendor = await this.requireCi(tenantId, input.vendorId, 'vendor');
    if (input.costCentreId !== null) await this.requireCi(tenantId, input.costCentreId, 'cost_centre');
    const contractId = await this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const ci = await this.upsertCi(tx, emit, tenantId, actor, id, {
        type: 'contract',
        identity: { [CONTRACT_ATTRIBUTES.vendorRef]: vendor.name, [CONTRACT_ATTRIBUTES.contractNumber]: input.contractNumber },
        name: input.title,
        attributes: {
          [CONTRACT_ATTRIBUTES.contractNumber]: input.contractNumber,
          [CONTRACT_ATTRIBUTES.vendorRef]: vendor.name,
          [CONTRACT_ATTRIBUTES.kind]: input.kind,
          [CONTRACT_ATTRIBUTES.title]: input.title,
          [CONTRACT_ATTRIBUTES.level]: input.level,
          [CONTRACT_ATTRIBUTES.responseMinutes]: input.responseMinutes,
          [CONTRACT_ATTRIBUTES.startsAt]: input.startsAt,
          [CONTRACT_ATTRIBUTES.endsAt]: input.endsAt,
          [CONTRACT_ATTRIBUTES.autoRenews]: input.autoRenews,
          [CONTRACT_ATTRIBUTES.noticeDays]: input.noticeDays,
          [CONTRACT_ATTRIBUTES.annualCost]: input.annualCost,
          [CONTRACT_ATTRIBUTES.currency]: input.currency,
          [CONTRACT_ATTRIBUTES.documents]: input.documents,
        },
      });
      await this.setOnlyLink(tx, emit, tenantId, actor, ci.id, SUPPORTED_BY, vendor.id);
      await this.setOnlyLink(tx, emit, tenantId, actor, ci.id, BILLED_TO, input.costCentreId);
      return ci.id;
    });
    const view = await this.contract(tenantId, contractId);
    if (!view) throw new NotFoundException('contract ' + contractId + ' not found');
    return view;
  }

  async upsertVendor(tenantId: string, actor: string, id: string | null, input: VendorInput): Promise<VendorView> {
    const vendorId = await this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const ci = await this.upsertCi(tx, emit, tenantId, actor, id, {
        type: 'vendor',
        identity: { name: input.name },
        name: input.name,
        attributes: { category: input.category, supportPortal: input.supportPortal, accountManager: input.accountManager },
      });
      return ci.id;
    });
    const detail = await this.vendor(tenantId, vendorId);
    if (!detail) throw new NotFoundException('vendor ' + vendorId + ' not found');
    return detail.vendor;
  }

  async upsertCostCentre(tenantId: string, actor: string, id: string | null, input: CostCentreInput): Promise<CostCentreView> {
    const centreId = await this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const ci = await this.upsertCi(tx, emit, tenantId, actor, id, {
        type: 'cost_centre',
        identity: { code: input.code },
        name: input.name,
        attributes: { code: input.code, name: input.name, kind: input.kind, owner: input.owner, annualBudget: input.annualBudget, currency: input.currency },
      });
      return ci.id;
    });
    const view = (await this.costCentres(tenantId)).find((c) => c.ci.id === centreId);
    if (!view) throw new NotFoundException('cost centre ' + centreId + ' not found');
    return view;
  }

  async upsertVendorContact(tenantId: string, input: VendorContactInput): Promise<VendorContactView> {
    await this.requireCi(tenantId, input.vendorId, 'vendor');
    const data = {
      name: input.name,
      role: input.role,
      email: input.email ?? null,
      phone: input.phone ?? null,
      portalUrl: input.portalUrl ?? null,
      availability: input.availability ?? null,
      escalationLevel: input.escalationLevel,
    };
    const client = this.prisma.client;
    const select = { id: true, vendorCiId: true, name: true, role: true, email: true, phone: true, portalUrl: true, availability: true, escalationLevel: true } as const;
    if (input.id) {
      const existing = await client.vendorContact.findFirst({ where: { id: input.id, tenantId }, select: { vendorCiId: true } });
      if (!existing) throw new NotFoundException('vendor contact ' + input.id + ' not found');
      if (existing.vendorCiId !== input.vendorId) throw new BadRequestException('a contact stays with its vendor');
      return client.vendorContact.update({ where: { id: input.id }, data, select });
    }
    return client.vendorContact.create({ data: { ...data, tenantId, vendorCiId: input.vendorId }, select });
  }

  async deleteVendorContact(tenantId: string, id: string): Promise<boolean> {
    const deleted = await this.prisma.client.vendorContact.deleteMany({ where: { id, tenantId } });
    if (deleted.count === 0) throw new NotFoundException('vendor contact ' + id + ' not found');
    return true;
  }

  /**
   * ADR-035 — the contract that covers an asset: the asset's CI is linked `covered_by` the contract (created when
   * missing) and the asset takes it as its support contract; null retires the asset CI's contract links.
   */
  async setAssetContract(tenantId: string, actor: string, assetId: string, contractId: string | null): Promise<AssetRecordView> {
    const asset = await this.prisma.client.assetRecord.findFirst({ where: { id: assetId, tenantId } });
    if (!asset) throw new NotFoundException('asset ' + assetId + ' not found');
    const ciId = asset.ciId;
    if (ciId === null) throw new BadRequestException('asset ' + asset.assetTag + ' has no CI yet; a planned unit is covered once it is received and discovered');
    if (contractId !== null) await this.requireCi(tenantId, contractId, 'contract');
    await this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const covering = await this.cis.relationshipsOfMany(tenantId, [ciId], [COVERED_BY], 'downstream');
      const contractIds = new Set((await this.cis.findByIds(tenantId, covering.map((r) => r.toCiId))).filter((c) => c.type === 'contract').map((c) => c.id));
      if (contractId === null) {
        const at = nowIso();
        for (const rel of covering.filter((r) => contractIds.has(r.toCiId))) {
          const retired = await this.cis.retireRelationship(tx, tenantId, rel.id, at);
          await emit({ type: 'openmap.relationship.retired', subject: retired.id, data: { relationshipId: retired.id, validTo: retired.validTo, by: actor } });
        }
      } else if (!contractIds.has(contractId)) await this.link(tx, emit, tenantId, actor, COVERED_BY, ciId, contractId);
      await tx.assetRecord.update({ where: { id: assetId }, data: { supportContractId: contractId } });
      await tx.assetAudit.create({
        data: { tenantId, assetId, actor, at: new Date(), field: 'supportContract', fromValue: asset.supportContractId, toValue: contractId, note: null },
      });
      await emit({ type: 'openmap.asset.updated', subject: assetId, data: { assetId, ciId, changed: ['supportContract'], by: actor } });
    });
    const [view] = await this.assets.assetsByIds(tenantId, [assetId]);
    if (!view) throw new NotFoundException('asset ' + assetId + ' not found');
    return view;
  }
}
