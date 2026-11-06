// REQ-CMDB-032 (ADR-036) — Query.certificates and the Certificate.issuedBy field resolver.
import { Args, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { z } from 'zod';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { CertificatesService, type CertificateView } from './certificates.service.js';

const certificateFilterSchema = z.object({
  text: z.string().nullish(),
  expiringWithinDays: z.number().int().min(0).nullish(),
  expired: z.boolean().nullish(),
  selfSigned: z.boolean().nullish(),
  weak: z.boolean().nullish(),
  includeAuthorities: z.boolean().nullish(),
});

@Resolver()
export class CertificatesResolver {
  constructor(
    private readonly service: CertificatesService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('certificates')
  certificates(@Args('filter') filter: unknown): Promise<CertificateView[]> {
    const f = parseInput(certificateFilterSchema, filter ?? {}, 'CertificateFilter');
    return this.service.certificates(this.tenant.tenantId, {
      text: f.text ?? null,
      expiringWithinDays: f.expiringWithinDays ?? null,
      expired: f.expired ?? null,
      selfSigned: f.selfSigned ?? null,
      weak: f.weak ?? null,
      includeAuthorities: f.includeAuthorities ?? false,
    });
  }
}

@Resolver('Certificate')
export class CertificateFieldsResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('issuedBy')
  issuedBy(@Parent() certificate: CertificateView): Promise<CiRecord | null> {
    return certificate.issuedById === null ? Promise.resolve(null) : this.tenant.loaders.ci.load(certificate.issuedById);
  }
}
