// REQ-INT-017 (ADR-075) — Query.ciProtection and Query.protectionGaps: whether backups protect a CI within its RPO, and
// the CIs supporting critical business services that they do not. The views carry CI records, which the Ci type
// resolves as everywhere else.
import { Args, Query, Resolver } from '@nestjs/graphql';
import { BACKUP_AWARENESS } from '@openmap/constants';
import { z } from 'zod';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { ProtectionService, type CiProtectionView, type ProtectionGapsView } from './protection.service.js';

const idArg = z.uuid();
const maxTierArg = z.number().int().min(1).nullable().optional();
const firstArg = z.number().int().min(1).max(BACKUP_AWARENESS.gapsMaxFirst).nullable().optional();

@Resolver()
export class ProtectionResolver {
  constructor(
    private readonly service: ProtectionService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('ciProtection')
  ciProtection(@Args('ciId') ciId: unknown): Promise<CiProtectionView | null> {
    return this.service.ci(this.tenant.tenantId, parseInput(idArg, ciId, 'ciId'));
  }

  @Query('protectionGaps')
  protectionGaps(@Args('maxTier') maxTier: unknown, @Args('first') first: unknown): Promise<ProtectionGapsView> {
    return this.service.gaps(
      this.tenant.tenantId,
      parseInput(maxTierArg, maxTier, 'maxTier') ?? BACKUP_AWARENESS.criticalMaxTier,
      parseInput(firstArg, first, 'first') ?? BACKUP_AWARENESS.gapsDefaultFirst,
    );
  }
}
