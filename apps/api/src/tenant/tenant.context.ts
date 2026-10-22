// REQ-CORE-012 — request-scoped tenant context. Resolvers inject it and pass tenantId to every
// repository call; a resolver cannot reach data without naming the caller's tenant.
import { Inject, Injectable, Scope, UnauthorizedException } from '@nestjs/common';
import { CONTEXT } from '@nestjs/graphql';
import type { Principal } from '../auth/principal.js';
import type { GqlContext } from '../graphql/context.js';

@Injectable({ scope: Scope.REQUEST })
export class TenantContext {
  constructor(@Inject(CONTEXT) private readonly context: GqlContext) {}

  get principal(): Principal {
    if (this.context.principal === null) throw new UnauthorizedException('a bearer token is required');
    return this.context.principal;
  }

  get tenantId(): string {
    return this.principal.tenantId;
  }

  get userId(): string {
    return this.principal.subject;
  }

  get username(): string {
    return this.principal.username;
  }

  get requestId(): string {
    return this.context.requestId;
  }

  get loaders(): NonNullable<GqlContext['loaders']> {
    if (this.context.loaders === null) throw new UnauthorizedException('a bearer token is required');
    return this.context.loaders;
  }
}
