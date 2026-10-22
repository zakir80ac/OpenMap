// REQ-CORE-012 — realm-role authorisation for resolvers annotated with @Roles().
import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext, type GqlContextType } from '@nestjs/graphql';
import type { GqlContext } from '../graphql/context.js';
import type { AuthenticatedRequest } from './auth.guard.js';
import type { Principal } from './principal.js';
import { REQUIRED_ROLES } from './roles.decorator.js';
import { hasAnyRole, type Role } from './roles.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(REQUIRED_ROLES, [context.getHandler(), context.getClass()]);
    if (required === undefined || required.length === 0) return true;
    const principal = this.principalOf(context);
    if (principal === null || !hasAnyRole(principal.roles, required)) {
      throw new ForbiddenException('requires one of the roles: ' + required.join(', '));
    }
    return true;
  }

  private principalOf(context: ExecutionContext): Principal | null {
    if (context.getType<GqlContextType>() === 'graphql') return GqlExecutionContext.create(context).getContext<GqlContext>().principal;
    return context.switchToHttp().getRequest<AuthenticatedRequest>().principal ?? null;
  }
}
