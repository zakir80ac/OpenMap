// REQ-CMDB-033 REQ-CMDB-036 (ADR-032) — Query.importJobs, Mutation.previewImport and Mutation.runImport. Operators
// import; everyone reads the job list. The file arrives as base64 in the input.
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { IMPORTS } from '@openmap/constants';
import { IMPORT_FORMATS } from '@openmap/contracts';
import { z } from 'zod';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { ImportsService, type ImportJobView, type ImportPreviewView } from './imports.service.js';

const importInput = z.object({
  filename: z.string().trim().min(1).max(IMPORTS.maxFilenameLength),
  format: z.enum(IMPORT_FORMATS),
  // Refused before decoding when the content cannot be a file within the limit.
  contentBase64: z.string().min(1).max(IMPORTS.maxBase64Length),
  mapping: z.unknown().nullish(),
});

@Resolver()
export class ImportsResolver {
  constructor(
    private readonly service: ImportsService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('importJobs')
  jobs(): Promise<ImportJobView[]> {
    return this.service.jobs(this.tenant.tenantId);
  }

  @Mutation('previewImport')
  @Roles(ROLES.operator)
  preview(@Args('input') input: unknown): Promise<ImportPreviewView> {
    const parsed = parseInput(importInput, input, 'ImportInput');
    return this.service.preview({ ...parsed, mapping: parsed.mapping ?? null });
  }

  @Mutation('runImport')
  @Roles(ROLES.operator)
  run(@Args('input') input: unknown): Promise<ImportJobView> {
    const parsed = parseInput(importInput, input, 'ImportInput');
    return this.service.run(this.tenant.tenantId, this.tenant.username, { ...parsed, mapping: parsed.mapping ?? null });
  }
}
