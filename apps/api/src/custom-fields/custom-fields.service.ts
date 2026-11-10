// REQ-CMDB-015 — custom fields: administrators define them per tenant (key, labels in both locales, type, options,
// the CI types they apply to, required), operators set values on CIs. Every value is read against its definition with
// the contract's validator; a definition's key is fixed once created; deleting a definition clears its values from
// every CI in the same transaction. Value changes emit `openmap.ci.updated` carrying the CI; all writes are audited by
// the global interceptor.
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CUSTOM_FIELDS } from '@openmap/constants';
import {
  applyCustomFieldChange,
  appliesToType,
  type CiType,
  type CustomFieldDefinition,
  type CustomFieldDefinitionInput,
  type CustomFieldValues,
  sensitiveKeys,
} from '@openmap/contracts';
import { Prisma, type PrismaClient } from '@openmap/db';
import { CI_INCLUDE, toCiRecord } from '../ci/ci.mapper.js';
import type { Actor } from '../ci/ci.service.js';
import type { CiRecord } from '../ci/ci.types.js';
import { isoOf } from '../common/time.js';
import { FieldCipherService } from '../db/field-cipher.service.js';
import { PrismaService } from '../db/prisma.service.js';
import { OutboxService } from '../outbox/outbox.service.js';

export interface CustomFieldDefinitionView extends CustomFieldDefinition {
  usage: number;
}

type Row = Awaited<ReturnType<PrismaClient['customFieldDefinition']['findFirstOrThrow']>>;

function toDefinition(row: Row): CustomFieldDefinition {
  return {
    id: row.id,
    tenantId: row.tenantId,
    key: row.key,
    labelEn: row.labelEn,
    labelAr: row.labelAr,
    description: row.description,
    type: row.type,
    options: row.options,
    appliesTo: row.appliesTo as CiType[],
    required: row.required,
    sensitive: row.sensitive,
    createdAt: isoOf(row.createdAt),
    updatedAt: isoOf(row.updatedAt),
  };
}

function valuesOf(json: unknown): CustomFieldValues {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return {};
  const out: CustomFieldValues = {};
  for (const [k, v] of Object.entries(json as Record<string, unknown>))
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  return out;
}

@Injectable()
export class CustomFieldsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly cipher: FieldCipherService,
  ) {}

  async definitions(tenantId: string, type: CiType | null): Promise<CustomFieldDefinitionView[]> {
    const rows = await this.prisma.client.customFieldDefinition.findMany({ where: { tenantId }, orderBy: { key: 'asc' } });
    const defs = rows.map(toDefinition).filter((d) => type === null || appliesToType(d, type));
    if (defs.length === 0) return [];
    const usage = await this.prisma.client.$queryRaw<Array<{ key: string; n: bigint }>>(Prisma.sql`
      SELECT k.key, count(*) AS n FROM cis c, jsonb_object_keys(c."customFields") AS k(key)
      WHERE c."tenantId" = ${tenantId}::uuid AND c."validTo" IS NULL GROUP BY k.key`);
    const byKey = new Map(usage.map((u) => [u.key, Number(u.n)]));
    return defs.map((d) => ({ ...d, usage: byKey.get(d.key) ?? 0 }));
  }

  async upsert(tenantId: string, id: string | null, input: CustomFieldDefinitionInput): Promise<CustomFieldDefinitionView> {
    const db = this.prisma.client;
    if (id === null) {
      const count = await db.customFieldDefinition.count({ where: { tenantId } });
      if (count >= CUSTOM_FIELDS.maxDefinitions) throw new ForbiddenException('a tenant may define at most ' + String(CUSTOM_FIELDS.maxDefinitions) + ' custom fields');
      const taken = await db.customFieldDefinition.findFirst({ where: { tenantId, key: input.key } });
      if (taken !== null) throw new ConflictException('custom field ' + input.key + ' already exists');
      const row = await db.customFieldDefinition.create({ data: { tenantId, ...input } });
      return { ...toDefinition(row), usage: 0 };
    }
    const existing = await db.customFieldDefinition.findFirst({ where: { id, tenantId } });
    if (existing === null) throw new NotFoundException('custom field ' + id + ' not found');
    if (existing.key !== input.key) throw new BadRequestException('the key of a custom field cannot change (' + existing.key + ')');
    // Values already stored keep their form; turning encryption on or off later would leave both kinds side by side.
    if (existing.sensitive !== input.sensitive) throw new BadRequestException('whether a custom field is sensitive is fixed once created (' + existing.key + ')');
    const row = await db.customFieldDefinition.update({ where: { id }, data: { ...input } });
    const [view] = (await this.definitions(tenantId, null)).filter((d) => d.id === row.id);
    return view ?? { ...toDefinition(row), usage: 0 };
  }

  /** Removes a definition and clears its values from every CI of the tenant. */
  async remove(tenantId: string, id: string): Promise<boolean> {
    const existing = await this.prisma.client.customFieldDefinition.findFirst({ where: { id, tenantId } });
    if (existing === null) throw new NotFoundException('custom field ' + id + ' not found');
    await this.prisma.client.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`UPDATE cis SET "customFields" = "customFields" - ${existing.key}, "updatedAt" = now() WHERE "tenantId" = ${tenantId}::uuid AND "customFields" ? ${existing.key}`);
      await tx.customFieldDefinition.delete({ where: { id } });
    });
    return true;
  }

  /** Sets values on a CI; null clears; each value is read against the definition that applies to the CI's type. */
  async setValues(actor: Actor, ciId: string, change: Record<string, unknown>): Promise<CiRecord> {
    const defs = (await this.prisma.client.customFieldDefinition.findMany({ where: { tenantId: actor.tenantId } })).map(toDefinition);
    return this.outbox.transaction(actor.tenantId, async ({ tx, emit }) => {
      const row = await tx.ci.findFirst({ where: { id: ciId, tenantId: actor.tenantId, validTo: null } });
      if (row === null) throw new NotFoundException('CI ' + ciId + ' not found');
      const applied = applyCustomFieldChange(defs, row.type as CiType, valuesOf(row.customFields), change);
      if (!applied.ok) throw new BadRequestException('custom fields: ' + applied.errors.join('; '));
      // REQ-SEC-011: a sensitive field's new value is stored as Transit ciphertext (stored values are already).
      const values = { ...applied.values };
      const sealedKeys = [...sensitiveKeys(defs)].filter((k) => typeof values[k] === 'string');
      const sealed = await this.cipher.encrypt(sealedKeys.map((k) => String(values[k])));
      sealedKeys.forEach((k, i) => {
        const v = sealed[i];
        if (typeof v === 'string') values[k] = v;
      });
      const updated = await tx.ci.update({ where: { id: ciId }, data: { customFields: values }, include: CI_INCLUDE });
      const ci = toCiRecord(updated);
      await emit({ type: 'openmap.ci.updated', subject: ci.id, data: { ci, ciId: ci.id, changed: ['customFields'], keys: Object.keys(change), by: actor.username } });
      return ci;
    });
  }
}
