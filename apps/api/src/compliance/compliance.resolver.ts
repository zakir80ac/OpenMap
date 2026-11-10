// REQ-SEC-012 (ADR-070) — Query.compliancePosture, Query.complianceControl, Mutation.evaluateCompliance (operators and
// auditors) and ComplianceFinding.ci through the request's CI loader.
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { COMPLIANCE } from '@openmap/constants';
import { COMPLIANCE_FRAMEWORKS, COMPLIANCE_RESULTS } from '@openmap/contracts';
import { z } from 'zod';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { ComplianceService, type ComplianceControlView, type ComplianceFindingView, type CompliancePostureView } from './compliance.service.js';

const frameworkArg = z.enum(COMPLIANCE_FRAMEWORKS);
const controlArg = z.string().trim().min(1).max(COMPLIANCE.controlIdMaxLength);
const resultArg = z.enum(COMPLIANCE_RESULTS);
const firstArg = z.number().int().min(1).max(COMPLIANCE.maxFindings);

@Resolver()
export class ComplianceResolver {
  constructor(
    private readonly service: ComplianceService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('compliancePosture')
  compliancePosture(): Promise<CompliancePostureView> {
    return this.service.posture(this.tenant.tenantId);
  }

  @Query('complianceControl')
  complianceControl(
    @Args('framework') framework: unknown,
    @Args('controlId') controlId: unknown,
    @Args('result') result: unknown,
    @Args('first') first: unknown,
  ): Promise<ComplianceControlView> {
    return this.service.control(
      this.tenant.tenantId,
      parseInput(frameworkArg, framework, 'framework'),
      parseInput(controlArg, controlId, 'controlId'),
      parseInput(resultArg, result, 'result'),
      parseInput(firstArg, first, 'first'),
    );
  }

  @Mutation('evaluateCompliance')
  @Roles(ROLES.operator, ROLES.auditor)
  evaluateCompliance(): Promise<CompliancePostureView> {
    return this.service.evaluate(this.tenant.tenantId, this.tenant.username);
  }
}

@Resolver('ComplianceFinding')
export class ComplianceFindingFieldsResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('ci')
  ci(@Parent() finding: ComplianceFindingView): Promise<CiRecord | null> {
    return finding.ciId === null ? Promise.resolve(null) : this.tenant.loaders.ci.load(finding.ciId);
  }
}
