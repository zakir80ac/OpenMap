// REQ-INT-005 — integration configuration, status and delivery persistence. Interface plus Prisma
// implementation over integration_configs, integration_statuses and integration_deliveries.
import { Injectable, NotFoundException } from '@nestjs/common';
import { integrationConfigSchema, type IntegrationConfig, type IntegrationDelivery } from '@openmap/contracts';
import { Prisma, type PrismaClient } from '@openmap/db';
import { isoOf, toIso } from '../common/time.js';
import { asRecord } from '../common/validation.js';
import { PrismaService } from '../db/prisma.service.js';
import type { IntegrationInput } from './integrations.schemas.js';
import type { IntegrationView } from './integrations.types.js';

export const INTEGRATIONS_REPOSITORY = Symbol('INTEGRATIONS_REPOSITORY');

export interface StatusPatch {
  health: IntegrationView['health'];
  lastSuccessAt?: string;
  lastError?: string | null;
  delivered?: number;
  failed?: number;
}

export interface IntegrationsRepository {
  list(tenantId: string, category: string | null): Promise<IntegrationView[]>;
  view(tenantId: string, id: string): Promise<IntegrationView | null>;
  viewsByIds(tenantId: string, ids: readonly string[]): Promise<IntegrationView[]>;
  /** Full contract-shaped configuration, for adapters. */
  config(tenantId: string, id: string): Promise<IntegrationConfig>;
  upsert(tx: Prisma.TransactionClient, tenantId: string, id: string | null, input: IntegrationInput): Promise<IntegrationView>;
  recordStatus(tx: Prisma.TransactionClient, id: string, patch: StatusPatch): Promise<void>;
  recordDelivery(tx: Prisma.TransactionClient, delivery: IntegrationDelivery): Promise<void>;
}

type ConfigRow = Prisma.IntegrationConfigGetPayload<{ include: { status: true } }>;
type ConfigOnly = Awaited<ReturnType<PrismaClient['integrationConfig']['findUniqueOrThrow']>>;

function toView(row: ConfigRow): IntegrationView {
  return {
    id: row.id,
    category: row.category,
    vendor: row.vendor,
    name: row.name,
    enabled: row.enabled,
    direction: row.direction,
    health: row.enabled ? (row.status?.health ?? 'warning') : 'disabled',
    lastSuccessAt: toIso(row.status?.lastSuccessAt),
    lastError: row.status?.lastError ?? null,
    deliveredLastHour: row.status?.deliveredLastHour ?? 0,
    failedLastHour: row.status?.failedLastHour ?? 0,
  };
}

export function toConfig(row: ConfigOnly): IntegrationConfig {
  return integrationConfigSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    category: row.category,
    vendor: row.vendor,
    name: row.name,
    enabled: row.enabled,
    direction: row.direction,
    endpoint: row.endpoint,
    credentialRef: row.credentialRef,
    settings: asRecord(row.settings),
    fieldMappings: Array.isArray(row.fieldMappings) ? row.fieldMappings : [],
    classMappings: Array.isArray(row.classMappings) ? row.classMappings : [],
    subscribedEvents: row.subscribedEvents,
    schedule: row.scheduleCron === null ? null : { cron: row.scheduleCron },
    createdAt: isoOf(row.createdAt),
    updatedAt: isoOf(row.updatedAt),
  });
}

@Injectable()
export class PrismaIntegrationsRepository implements IntegrationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, category: string | null): Promise<IntegrationView[]> {
    const where: Prisma.IntegrationConfigWhereInput = { tenantId };
    if (category !== null) where.category = category as IntegrationConfig['category'];
    const rows = await this.prisma.client.integrationConfig.findMany({ where, include: { status: true }, orderBy: { name: 'asc' } });
    return rows.map(toView);
  }

  async view(tenantId: string, id: string): Promise<IntegrationView | null> {
    const row = await this.prisma.client.integrationConfig.findFirst({ where: { id, tenantId }, include: { status: true } });
    return row ? toView(row) : null;
  }

  async viewsByIds(tenantId: string, ids: readonly string[]): Promise<IntegrationView[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.client.integrationConfig.findMany({ where: { tenantId, id: { in: [...ids] } }, include: { status: true } });
    return rows.map(toView);
  }

  async config(tenantId: string, id: string): Promise<IntegrationConfig> {
    const row = await this.prisma.client.integrationConfig.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('integration ' + id + ' not found');
    return toConfig(row);
  }

  async upsert(tx: Prisma.TransactionClient, tenantId: string, id: string | null, input: IntegrationInput): Promise<IntegrationView> {
    const data = {
      category: input.category,
      vendor: input.vendor,
      name: input.name,
      endpoint: input.endpoint,
      credentialRef: input.credentialRef,
      direction: input.direction,
      settings: (input.settings ?? {}) as Prisma.InputJsonObject,
      fieldMappings: (input.fieldMappings ?? []) as unknown as Prisma.InputJsonArray,
      classMappings: (input.classMappings ?? []) as unknown as Prisma.InputJsonArray,
      subscribedEvents: input.subscribedEvents ?? [],
    };
    if (id !== null) {
      const existing = await tx.integrationConfig.findFirst({ where: { id, tenantId } });
      if (!existing) throw new NotFoundException('integration ' + id + ' not found');
      const row = await tx.integrationConfig.update({ where: { id }, data, include: { status: true } });
      return toView(row);
    }
    const row = await tx.integrationConfig.create({ data: { ...data, tenantId, enabled: true, status: { create: { health: 'warning' } } }, include: { status: true } });
    return toView(row);
  }

  async recordStatus(tx: Prisma.TransactionClient, id: string, patch: StatusPatch): Promise<void> {
    const update: Prisma.IntegrationStatusUpdateInput = { health: patch.health };
    if (patch.lastSuccessAt !== undefined) update.lastSuccessAt = new Date(patch.lastSuccessAt);
    if (patch.lastError !== undefined) {
      update.lastError = patch.lastError;
      if (patch.lastError !== null) update.lastErrorAt = new Date();
    }
    if (patch.delivered !== undefined) update.deliveredLastHour = { increment: patch.delivered };
    if (patch.failed !== undefined) update.failedLastHour = { increment: patch.failed };
    await tx.integrationStatus.upsert({ where: { integrationId: id }, create: { integrationId: id, health: patch.health }, update });
  }

  async recordDelivery(tx: Prisma.TransactionClient, d: IntegrationDelivery): Promise<void> {
    await tx.integrationDelivery.create({
      data: {
        id: d.id,
        tenantId: d.tenantId,
        integrationId: d.integrationId,
        direction: d.direction,
        eventId: d.eventId,
        remoteId: d.remoteId,
        state: d.state,
        attempts: d.attempts,
        requestDigest: d.requestDigest,
        responseCode: d.responseCode,
        error: d.error,
        createdAt: new Date(d.createdAt),
        completedAt: d.completedAt === null ? null : new Date(d.completedAt),
      },
    });
  }
}
