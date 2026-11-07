// REQ-BSM-007 (ADR-025) — Query.connectivity and the ReadinessFinding field resolvers (subject CI and incident).
import { Inject } from '@nestjs/common';
import { Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord } from '../ci/ci.types.js';
import { ServicesService } from '../services/services.service.js';
import type { IncidentRecord } from '../services/services.types.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { ConnectivityService, type ConnectivityView, type ReadinessFindingView } from './connectivity.service.js';

@Resolver()
export class ConnectivityResolver {
  constructor(
    private readonly service: ConnectivityService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('connectivity')
  connectivity(): Promise<ConnectivityView> {
    return this.service.connectivity(this.tenant.tenantId);
  }
}

@Resolver('ReadinessFinding')
export class ReadinessFindingFieldsResolver {
  constructor(
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly services: ServicesService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('subject')
  async subject(@Parent() f: ReadinessFindingView): Promise<CiRecord | null> {
    return (await this.cis.findByIds(this.tenant.tenantId, [f.subjectCiId]))[0] ?? null;
  }

  @ResolveField('incident')
  incident(@Parent() f: ReadinessFindingView): Promise<IncidentRecord | null> | null {
    return f.incidentId === null ? null : this.services.incident(this.tenant.tenantId, f.incidentId);
  }
}
