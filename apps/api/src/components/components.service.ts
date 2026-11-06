// REQ-CMDB-014 (ADR-037) — the parts register over `ci_components`: one CI's parts (current, or with the removed ones)
// and the estate-wide register with a text and kind filter, a page of parts and the most common kind-and-model rows.
import { Injectable } from '@nestjs/common';
import { COMPONENTS } from '@openmap/constants';
import type { ComponentKind } from '@openmap/contracts';
import { Prisma } from '@openmap/db';
import { PrismaService } from '../db/prisma.service.js';

export interface ComponentView {
  id: string;
  ciId: string;
  kind: ComponentKind;
  slot: string;
  model: string | null;
  manufacturer: string | null;
  serialNumber: string | null;
  partNumber: string | null;
  capacityBytes: number | null;
  firmware: string | null;
  details: Prisma.JsonValue;
  firstSeenAt: Date;
  lastSeenAt: Date;
  removedAt: Date | null;
}

export interface ComponentModelCount {
  kind: ComponentKind;
  model: string | null;
  count: number;
}

export interface ComponentPageView {
  items: ComponentView[];
  total: number;
  models: ComponentModelCount[];
}

export interface ComponentFilter {
  kind: ComponentKind | null;
  text: string | null;
  includeRemoved: boolean;
}

const ORDER: Prisma.CiComponentOrderByWithRelationInput[] = [{ kind: 'asc' }, { slot: 'asc' }];

function view(row: Prisma.CiComponentGetPayload<object>): ComponentView {
  return { ...row, kind: row.kind as ComponentKind };
}

@Injectable()
export class ComponentsService {
  constructor(private readonly prisma: PrismaService) {}

  async ofCi(tenantId: string, ciId: string, includeRemoved: boolean): Promise<ComponentView[]> {
    const rows = await this.prisma.client.ciComponent.findMany({
      where: { tenantId, ciId, ...(includeRemoved ? {} : { removedAt: null }) },
      orderBy: ORDER,
    });
    return rows.map(view);
  }

  private where(tenantId: string, filter: ComponentFilter): Prisma.CiComponentWhereInput {
    const text = filter.text?.trim() ?? '';
    const contains = { contains: text, mode: 'insensitive' as const };
    return {
      tenantId,
      ...(filter.includeRemoved ? {} : { removedAt: null }),
      ...(filter.kind === null ? {} : { kind: filter.kind }),
      ...(text === ''
        ? {}
        : {
            OR: [
              { model: contains },
              { manufacturer: contains },
              { serialNumber: contains },
              { partNumber: contains },
              { slot: contains },
              { ci: { name: contains } },
            ],
          }),
    };
  }

  async page(tenantId: string, filter: ComponentFilter, first: number, offset: number): Promise<ComponentPageView> {
    const where = this.where(tenantId, filter);
    const take = Math.min(Math.max(first, 0), COMPONENTS.maxPageSize);
    const [rows, total, groups] = await Promise.all([
      this.prisma.client.ciComponent.findMany({ where, orderBy: [{ kind: 'asc' }, { model: 'asc' }, { ciId: 'asc' }, { slot: 'asc' }], take, skip: Math.max(offset, 0) }),
      this.prisma.client.ciComponent.count({ where }),
      this.prisma.client.ciComponent.groupBy({
        by: ['kind', 'model'],
        where,
        _count: { _all: true },
        orderBy: { _count: { id: 'desc' } },
        take: COMPONENTS.topModels,
      }),
    ]);
    return {
      items: rows.map(view),
      total,
      models: groups.map((g) => ({ kind: g.kind as ComponentKind, model: g.model, count: g._count._all })),
    };
  }
}
