// REQ-CMDB-001 — Prisma implementation of the CMDB repository over the `cis` and `relationships`
// tables, including bitemporal reads through the validAt predicate.
import { Injectable, NotFoundException } from '@nestjs/common';
import { CI_IDENTITY_KEYS, CI_TYPE_LAYER, ciCode, type CiLayer, type CiType, type RelationshipType, type UserLabel } from '@openmap/contracts';
import { Prisma } from '@openmap/db';
import { checksumOf } from './checksum.js';
import type { SortKey } from '../common/cursor.js';
import { relationshipValidAt, validAt } from '../common/time.js';
import { PrismaService } from '../db/prisma.service.js';
import { CI_INCLUDE, toCiRecord, toRelationshipRecord } from './ci.mapper.js';
import { buildCiWhere, CI_ORDER, textClause } from './ci.filter.js';
import type { CiRepository, ListResult, NewCi, NewRelationship, RelationshipQuery } from './ci.repository.js';
import type { CiFilterInput } from './ci.schemas.js';
import type { CiRecord, RelationshipDirection, RelationshipRecord } from './ci.types.js';

/** Provenance recorded for user-made changes through the API. */
export const API_SOURCE = { collectorId: 'api', nodeId: 'api' } as const;

/**
 * The reconciler's identity key (apps/reconciler/src/core/identity.ts): identity values in CI_IDENTITY_KEYS order,
 * trimmed and lower-cased, joined by '|'. A CI the wizard creates must carry the same key so a later sweep
 * reconciles onto it instead of creating a duplicate.
 */
export function identityKeyOf(type: CiType, identity: Record<string, string>): string {
  return CI_IDENTITY_KEYS[type]
    .map((k) => identity[k])
    .filter((v): v is string => v !== undefined && v !== '')
    .map((v) => v.trim().toLowerCase())
    .join('|');
}

@Injectable()
export class PrismaCiRepository implements CiRepository {
  constructor(private readonly prisma: PrismaService) {}

  private get db() {
    return this.prisma.client;
  }

  async findById(tenantId: string, id: string, asOf: string | null): Promise<CiRecord | null> {
    const row = await this.db.ci.findFirst({
      where: { id, tenantId, ...validAt(asOf) },
      include: CI_INCLUDE,
    });
    return row ? toCiRecord(row) : null;
  }

  async findCurrentByIdentity(tenantId: string, type: CiType, identity: Record<string, string>): Promise<CiRecord | null> {
    const row = await this.db.ci.findFirst({
      where: { tenantId, type, identityKey: identityKeyOf(type, identity), validTo: null },
      include: CI_INCLUDE,
    });
    return row ? toCiRecord(row) : null;
  }

  async create(tx: Prisma.TransactionClient, tenantId: string, input: NewCi): Promise<CiRecord> {
    const layer = CI_TYPE_LAYER[input.type];
    const now = new Date();
    const row = await tx.ci.create({
      data: {
        ...(input.id === undefined ? {} : { id: input.id }),
        tenantId,
        type: input.type,
        identity: input.identity,
        identityKey: identityKeyOf(input.type, input.identity),
        name: input.name,
        displayName: input.name,
        code: ciCode(layer, input.type, input.name),
        layer,
        lifecycle: input.lifecycle,
        attributes: input.attributes as Prisma.InputJsonObject,
        tags: input.tags,
        sourceCollectorId: API_SOURCE.collectorId,
        sourceNodeId: API_SOURCE.nodeId,
        sourceRunId: input.runId,
        sourceConfidence: input.confidence,
        observedAt: now,
        validFrom: now,
        checksum: checksumOf(input.type, input.identity, input.attributes),
      },
      include: CI_INCLUDE,
    });
    return toCiRecord(row);
  }

  async retire(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<CiRecord> {
    const existing = await tx.ci.findFirst({ where: { id, tenantId, validTo: null } });
    if (!existing) throw new NotFoundException('CI ' + id + ' not found');
    const now = new Date();
    await tx.relationship.updateMany({ where: { tenantId, validTo: null, OR: [{ fromCiId: id }, { toCiId: id }] }, data: { validTo: now } });
    const row = await tx.ci.update({ where: { id }, data: { validTo: now }, include: CI_INCLUDE });
    return toCiRecord(row);
  }

  async findByIds(tenantId: string, ids: readonly string[]): Promise<CiRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.ci.findMany({
      where: { tenantId, id: { in: [...ids] } },
      include: CI_INCLUDE,
    });
    return rows.map(toCiRecord);
  }

  async list(
    tenantId: string,
    filter: CiFilterInput,
    healthIds: readonly string[] | null,
    first: number,
    after: SortKey | null,
  ): Promise<ListResult<CiRecord>> {
    const where = buildCiWhere(tenantId, filter, healthIds, after);
    const countWhere = buildCiWhere(tenantId, filter, healthIds, null);
    const [rows, totalCount] = await Promise.all([
      this.db.ci.findMany({ where, orderBy: CI_ORDER, take: first + 1, include: CI_INCLUDE }),
      this.db.ci.count({ where: countWhere }),
    ]);
    return { items: rows.slice(0, first).map(toCiRecord), hasNextPage: rows.length > first, totalCount };
  }

  async search(
    tenantId: string,
    text: string,
    layers: readonly CiLayer[],
    first: number,
  ): Promise<CiRecord[]> {
    const where: Prisma.CiWhereInput = { tenantId, validTo: null, AND: [textClause(text)] };
    if (layers.length > 0) where.layer = { in: [...layers] };
    const rows = await this.db.ci.findMany({ where, orderBy: CI_ORDER, take: first, include: CI_INCLUDE });
    return rows.map(toCiRecord);
  }

  async byType(tenantId: string, type: CiType): Promise<CiRecord[]> {
    const rows = await this.db.ci.findMany({
      where: { tenantId, type, validTo: null },
      orderBy: CI_ORDER,
      include: CI_INCLUDE,
    });
    return rows.map(toCiRecord);
  }

  async relationships(tenantId: string, q: RelationshipQuery): Promise<ListResult<RelationshipRecord>> {
    const endpoint: Prisma.RelationshipWhereInput =
      q.direction === 'upstream'
        ? { toCiId: q.ciId }
        : q.direction === 'downstream'
          ? { fromCiId: q.ciId }
          : { OR: [{ fromCiId: q.ciId }, { toCiId: q.ciId }] };
    const and: Prisma.RelationshipWhereInput[] = [endpoint, relationshipValidAt(q.asOf)];
    if (q.types.length > 0) and.push({ type: { in: [...q.types] } });
    const countWhere: Prisma.RelationshipWhereInput = { tenantId, AND: and };
    const where: Prisma.RelationshipWhereInput = {
      tenantId,
      AND: q.afterId === null ? and : [...and, { id: { gt: q.afterId } }],
    };
    const [rows, totalCount] = await Promise.all([
      this.db.relationship.findMany({ where, orderBy: { id: 'asc' }, take: q.first + 1 }),
      this.db.relationship.count({ where: countWhere }),
    ]);
    return {
      items: rows.slice(0, q.first).map(toRelationshipRecord),
      hasNextPage: rows.length > q.first,
      totalCount,
    };
  }

  async relationshipById(tenantId: string, id: string): Promise<RelationshipRecord | null> {
    const row = await this.db.relationship.findFirst({ where: { id, tenantId } });
    return row ? toRelationshipRecord(row) : null;
  }

  async relationshipsByIds(tenantId: string, ids: readonly string[]): Promise<RelationshipRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.relationship.findMany({ where: { tenantId, id: { in: [...ids] } } });
    return rows.map(toRelationshipRecord);
  }

  async relationshipsOfMany(
    tenantId: string,
    ciIds: readonly string[],
    types: readonly RelationshipType[],
    direction: Exclude<RelationshipDirection, 'both'>,
  ): Promise<RelationshipRecord[]> {
    if (ciIds.length === 0) return [];
    const where: Prisma.RelationshipWhereInput = { tenantId, validTo: null };
    if (types.length > 0) where.type = { in: [...types] };
    if (direction === 'upstream') where.toCiId = { in: [...ciIds] };
    else where.fromCiId = { in: [...ciIds] };
    const rows = await this.db.relationship.findMany({ where, orderBy: { id: 'asc' } });
    return rows.map(toRelationshipRecord);
  }

  async relationshipsByType(tenantId: string, type: RelationshipType): Promise<RelationshipRecord[]> {
    const rows = await this.db.relationship.findMany({
      where: { tenantId, type, validTo: null },
      orderBy: { id: 'asc' },
    });
    return rows.map(toRelationshipRecord);
  }

  async versions(tenantId: string, id: string, from: string | null, to: string | null): Promise<CiRecord[]> {
    const and: Prisma.CiWhereInput[] = [];
    if (to !== null) and.push({ validFrom: { lte: new Date(to) } });
    if (from !== null) and.push({ OR: [{ validTo: null }, { validTo: { gte: new Date(from) } }] });
    const rows = await this.db.ci.findMany({
      where: { id, tenantId, AND: and },
      orderBy: { validFrom: 'asc' },
      include: CI_INCLUDE,
    });
    return rows.map(toCiRecord);
  }

  async label(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    label: UserLabel,
    layer: CiLayer,
    type: CiType | null,
  ): Promise<CiRecord> {
    const existing = await tx.ci.findFirst({ where: { id, tenantId, validTo: null } });
    if (!existing) throw new NotFoundException('CI ' + id + ' not found');
    const data: Prisma.CiUncheckedUpdateInput = { userLabel: label, layer };
    if (type !== null) data.type = type;
    const row = await tx.ci.update({ where: { id }, data, include: CI_INCLUDE });
    return toCiRecord(row);
  }

  async updateAttributes(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    attributes: Record<string, unknown>,
    checksum: string,
  ): Promise<CiRecord> {
    const existing = await tx.ci.findFirst({ where: { id, tenantId, validTo: null } });
    if (!existing) throw new NotFoundException('CI ' + id + ' not found');
    const row = await tx.ci.update({
      where: { id },
      data: { attributes: attributes as Prisma.InputJsonObject, checksum },
      include: CI_INCLUDE,
    });
    return toCiRecord(row);
  }

  async findCurrentByCode(tenantId: string, code: string): Promise<CiRecord | null> {
    const row = await this.db.ci.findFirst({ where: { tenantId, code, validTo: null }, include: CI_INCLUDE });
    return row ? toCiRecord(row) : null;
  }

  async updateCode(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    code: string,
  ): Promise<CiRecord> {
    const existing = await tx.ci.findFirst({ where: { id, tenantId, validTo: null } });
    if (!existing) throw new NotFoundException('CI ' + id + ' not found');
    const row = await tx.ci.update({ where: { id }, data: { code }, include: CI_INCLUDE });
    return toCiRecord(row);
  }

  async createRelationship(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: NewRelationship,
  ): Promise<RelationshipRecord> {
    const endIds = [...new Set([input.fromCiId, input.toCiId])];
    const ends = await tx.ci.count({ where: { tenantId, validTo: null, id: { in: endIds } } });
    if (ends !== endIds.length)
      throw new NotFoundException('both ends of the relationship must be current CIs of the tenant');
    const now = new Date();
    const row = await tx.relationship.create({
      data: {
        tenantId,
        type: input.type,
        fromCiId: input.fromCiId,
        toCiId: input.toCiId,
        attributes: input.attributes as Prisma.InputJsonObject,
        sourceCollectorId: API_SOURCE.collectorId,
        sourceNodeId: API_SOURCE.nodeId,
        sourceRunId: input.runId,
        sourceConfidence: input.confidence,
        observedAt: now,
        validFrom: now,
      },
    });
    return toRelationshipRecord(row);
  }

  async retireRelationship(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    at: string,
  ): Promise<RelationshipRecord> {
    const existing = await tx.relationship.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException('relationship ' + id + ' not found');
    if (existing.validTo !== null) return toRelationshipRecord(existing);
    const row = await tx.relationship.update({ where: { id }, data: { validTo: new Date(at) } });
    return toRelationshipRecord(row);
  }
}
