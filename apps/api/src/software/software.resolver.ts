// REQ-UI-015 REQ-UI-016 — Query.software, Query.vulnerabilitySummaries and Query.vulnerability (ADR-013).
import { Args, Query, Resolver } from '@nestjs/graphql';
import { z } from 'zod';
import { clampPageSize } from '../common/cursor.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { SoftwareService } from './software.service.js';
import type { SoftwareProductView, VulnerabilityDetailView, VulnerabilitySummaryView } from './software.types.js';

const softwareArgs = z.object({ text: z.string().nullish(), licensedOnly: z.boolean().nullish(), first: z.number().int().nullish() });
const vulnerabilitiesArgs = z.object({ minCvss: z.number().min(0).nullish(), exploitedOnly: z.boolean().nullish(), internetFacing: z.boolean().nullish() });
const cveArg = z.string().min(1);

@Resolver()
export class SoftwareResolver {
  constructor(
    private readonly service: SoftwareService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('software')
  software(@Args('text') text: unknown, @Args('licensedOnly') licensedOnly: unknown, @Args('first') first: unknown): Promise<SoftwareProductView[]> {
    const a = parseInput(softwareArgs, { text, licensedOnly, first }, 'software arguments');
    return this.service.software(this.tenant.tenantId, a.text ?? null, a.licensedOnly ?? false, clampPageSize(a.first));
  }

  @Query('vulnerabilitySummaries')
  vulnerabilitySummaries(@Args('minCvss') minCvss: unknown, @Args('exploitedOnly') exploitedOnly: unknown, @Args('internetFacing') internetFacing: unknown): Promise<VulnerabilitySummaryView[]> {
    const a = parseInput(vulnerabilitiesArgs, { minCvss, exploitedOnly, internetFacing }, 'vulnerabilitySummaries arguments');
    return this.service.vulnerabilitySummaries(this.tenant.tenantId, a.minCvss ?? null, a.exploitedOnly ?? false, a.internetFacing ?? null);
  }

  @Query('vulnerability')
  vulnerability(@Args('cveId') cveId: unknown): Promise<VulnerabilityDetailView | null> {
    return this.service.vulnerability(this.tenant.tenantId, parseInput(cveArg, cveId, 'cveId'));
  }
}
