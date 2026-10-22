// REQ-SEC-005 — `auditLog` query: the tenant's audit entries, newest first, for auditors and administrators.
import { Args, Query, Resolver } from '@nestjs/graphql';
import { z } from 'zod';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { AuditService, type AuditEntry } from './audit.service.js';

const auditArgsSchema = z.object({
  subjectType: z.string().min(1).nullish(),
  subjectId: z.string().min(1).nullish(),
  actor: z.string().min(1).nullish(),
  action: z.string().min(1).nullish(),
  first: z.number().int().nullish(),
  after: z.string().min(1).nullish(),
});

interface AuditEdge {
  cursor: string;
  node: AuditEntry;
}

interface AuditConnection {
  edges: AuditEdge[];
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
  totalCount: number;
}

@Resolver()
export class AuditResolver {
  constructor(
    private readonly audit: AuditService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('auditLog')
  @Roles(ROLES.auditor)
  async auditLog(@Args('subjectType') subjectType: unknown, @Args('subjectId') subjectId: unknown, @Args('actor') actor: unknown, @Args('action') action: unknown, @Args('first') first: unknown, @Args('after') after: unknown): Promise<AuditConnection> {
    const args = parseInput(auditArgsSchema, { subjectType, subjectId, actor, action, first, after }, 'auditLog arguments');
    const page = await this.audit.list(this.tenant.tenantId, { subjectType: args.subjectType, subjectId: args.subjectId, actor: args.actor, action: args.action }, args.first, args.after);
    return {
      edges: page.entries.map((node) => ({ cursor: Buffer.from(JSON.stringify({ name: node.at.toISOString(), id: node.id }), 'utf8').toString('base64url'), node })),
      pageInfo: { endCursor: page.endCursor, hasNextPage: page.hasNextPage },
      totalCount: page.totalCount,
    };
  }
}
