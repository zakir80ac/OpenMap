// REQ-AI-003 (ADR-053) — Query.anomalies, Mutation.detectAnomalies / explainAnomaly and AnomalyFinding.subject.
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { LOCALES } from '@openmap/constants';
import { z } from 'zod';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { AnomalyService, type AnomalyFindingView, type AnomalyReportView } from './anomaly.service.js';

const idArg = z.uuid();
const localeArg = z.enum(LOCALES);

@Resolver()
export class AnomalyResolver {
  constructor(
    private readonly service: AnomalyService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('anomalies')
  anomalies(): Promise<AnomalyReportView> {
    return this.service.report(this.tenant.tenantId);
  }

  @Mutation('detectAnomalies')
  @Roles(ROLES.operator)
  async detectAnomalies(): Promise<AnomalyReportView> {
    await this.service.detect(this.tenant.tenantId);
    return this.service.report(this.tenant.tenantId);
  }

  @Mutation('explainAnomaly')
  explainAnomaly(@Args('id') id: unknown, @Args('locale') locale: unknown): Promise<AnomalyFindingView> {
    return this.service.explain(this.tenant.tenantId, parseInput(idArg, id, 'anomaly id'), parseInput(localeArg, locale, 'locale'));
  }
}

@Resolver('AnomalyFinding')
export class AnomalyFindingFieldsResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('subject')
  subject(@Parent() f: AnomalyFindingView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(f.subjectCiId);
  }
}
