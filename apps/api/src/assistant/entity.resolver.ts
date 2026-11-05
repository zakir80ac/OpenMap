// REQ-AI-007 (ADR-028) — names in a question become CIs: an exact match on name, display name or code wins; several
// exact matches are a clarification, not a guess; no exact match falls back to the text search so the assistant can
// offer the closest items instead of answering about nothing.
import { Inject, Injectable } from '@nestjs/common';
import { ASSISTANT } from '@openmap/constants';
import type { CiType } from '@openmap/contracts';
import { Prisma } from '@openmap/db';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord } from '../ci/ci.types.js';
import { PrismaService } from '../db/prisma.service.js';

export interface NameResolution {
  name: string;
  /** Exact matches (case-insensitive) on name, display name or code. */
  exact: CiRecord[];
  /** Closest items by text search when nothing matched exactly. */
  close: CiRecord[];
}

@Injectable()
export class EntityResolver {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
  ) {}

  async resolve(tenantId: string, name: string, types: readonly CiType[] = []): Promise<NameResolution> {
    const where: Prisma.CiWhereInput = {
      tenantId,
      validTo: null,
      OR: [
        { name: { equals: name, mode: Prisma.QueryMode.insensitive } },
        { displayName: { equals: name, mode: Prisma.QueryMode.insensitive } },
        { code: { equals: name.toUpperCase() } },
      ],
    };
    if (types.length > 0) where.type = { in: [...types] };
    const rows = await this.prisma.client.ci.findMany({
      where,
      select: { id: true },
      take: ASSISTANT.clarificationChoices + 1,
    });
    const exact = await this.cis.findByIds(
      tenantId,
      rows.map((r) => r.id),
    );
    if (exact.length > 0) return { name, exact, close: [] };
    const close = await this.cis.search(tenantId, name, [], ASSISTANT.clarificationChoices);
    return {
      name,
      exact: [],
      close: types.length === 0 ? close : close.filter((c) => types.includes(c.type)),
    };
  }

  /** Every name resolved; a name with exactly one match is settled, the others need the person. */
  async resolveAll(
    tenantId: string,
    names: readonly string[],
    types: readonly CiType[] = [],
  ): Promise<NameResolution[]> {
    return Promise.all(names.map((n) => this.resolve(tenantId, n, types)));
  }
}
