// REQ-SEC-005 — records every successful GraphQL mutation in the audit log (ADR-010). Runs as a global interceptor:
// the mutation's field name is the action, the returned object's `id` and GraphQL type name are the subject, and the
// arguments (redacted) are the details. Queries and subscriptions are not audited; a mutation that throws leaves no
// entry, because the entry is written after the resolver resolves.
import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { GraphQLResolveInfo } from 'graphql';
import { Observable, from, of } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import type { GqlContext } from '../graphql/context.js';
import { AuditService } from './audit.service.js';

const MUTATION_TYPE = 'Mutation';

/** Name of the GraphQL object type a mutation returned (lists and non-null wrappers unwrapped). */
export function returnTypeName(info: GraphQLResolveInfo): string {
  let type: unknown = info.returnType;
  for (;;) {
    const named = type as { ofType?: unknown; name?: string };
    if (named.ofType !== undefined) {
      type = named.ofType;
      continue;
    }
    return named.name ?? 'Unknown';
  }
}

/** The subject id: the returned object's `id` when it has one, else the first UUID-looking argument, else the action. */
export function subjectIdOf(result: unknown, args: Record<string, unknown>, action: string): string {
  if (result !== null && typeof result === 'object' && typeof (result as { id?: unknown }).id === 'string') return (result as { id: string }).id;
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value !== '') return value;
    if (value !== null && typeof value === 'object') {
      const nested = (value as Record<string, unknown>)['ciId'] ?? (value as Record<string, unknown>)['id'];
      if (typeof nested === 'string') return nested;
    }
  }
  return action;
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType<string>() !== 'graphql') return next.handle();
    const gql = GqlExecutionContext.create(context);
    const info = gql.getInfo<GraphQLResolveInfo>();
    if (info.parentType.name !== MUTATION_TYPE) return next.handle();
    const ctx = gql.getContext<GqlContext>();
    const principal = ctx.principal;
    if (principal === null) return next.handle();
    const args = gql.getArgs<Record<string, unknown>>();
    const action = info.fieldName;
    return next.handle().pipe(
      mergeMap((result: unknown) =>
        from(
          this.audit
            .record({ tenantId: principal.tenantId, username: principal.username, requestId: ctx.requestId }, action, returnTypeName(info), subjectIdOf(result, args, action), { arguments: args })
            .then(() => result),
        ).pipe(mergeMap((value) => of(value))),
      ),
    );
  }
}
