// REQ-CORE-012 — resolves the JWT `tenant` claim to a tenant id. The claim is either the tenant's
// UUID or its slug (the URL-safe name the Keycloak realm import attaches to users). Slug lookups are
// cached per process; a miss falls through to Postgres so new tenants work without a restart.
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { isUuid } from '../common/uuid.js';
import { PrismaService } from '../db/prisma.service.js';

@Injectable()
export class TenantDirectory {
  private readonly bySlug = new Map<string, string>();

  constructor(private readonly prisma: PrismaService) {}

  async resolve(claim: string): Promise<string> {
    if (isUuid(claim)) return claim.toLowerCase();
    const cached = this.bySlug.get(claim);
    if (cached !== undefined) return cached;
    const tenant = await this.prisma.client.tenant.findFirst({ where: { slug: claim, active: true }, select: { id: true } });
    if (!tenant) throw new UnauthorizedException('unknown tenant "' + claim + '"');
    this.bySlug.set(claim, tenant.id);
    return tenant.id;
  }
}
