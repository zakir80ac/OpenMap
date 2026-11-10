// REQ-INT-019 (ADR-066) — Query.backups for administrators: the backup sets and their freshness.
import { Query, Resolver } from '@nestjs/graphql';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import { BackupsService, type BackupsView } from './backups.service.js';

@Resolver()
export class BackupsResolver {
  constructor(private readonly service: BackupsService) {}

  @Query('backups')
  @Roles(ROLES.admin)
  backups(): Promise<BackupsView> {
    return this.service.list();
  }
}
