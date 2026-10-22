// REQ-CORE-012 — global authentication guard: every GraphQL operation and every non-public HTTP
// route needs a verified principal in its context.
import { Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext, type GqlContextType } from '@nestjs/graphql';
import type { FastifyRequest } from 'fastify';
import type { GqlContext } from '../graphql/context.js';
import { AuthService } from './auth.service.js';
import { IS_PUBLIC } from './public.decorator.js';
import type { Principal } from './principal.js';

export type AuthenticatedRequest = FastifyRequest & { principal?: Principal };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]) === true) return true;
    if (context.getType<GqlContextType>() === 'graphql') {
      const gql = GqlExecutionContext.create(context).getContext<GqlContext>();
      if (gql.principal === null) throw new UnauthorizedException(gql.authError ?? 'a bearer token is required');
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = await this.auth.verifyHeader(request.headers.authorization);
    if (principal === null) throw new UnauthorizedException('a bearer token is required');
    request.principal = principal;
    return true;
  }
}
