// REQ-CORE-019 (ADR-049) REQ-INT-011 (ADR-072) — what every REST v1 handler shares: the route table's schemas parse the
// path and query (a failure is a 400 naming each issue), and each call runs in its rest.<route> span, counted and timed
// by route id and outcome status. The CMDB routes (rest.controller.ts) and the inventory routes (inventory.controller.ts)
// both run through it, so the counters and spans read the same for every route.
import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { TIME } from '@openmap/constants';
import { REST_ROUTES, type RestRouteId } from '@openmap/contracts';
import { withSpan } from '@openmap/telemetry';
import type { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import type { Principal } from '../auth/principal.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import type { MetricsService } from '../metrics/metrics.service.js';

type Route<K extends RestRouteId> = (typeof REST_ROUTES)[K];
export type QueryOf<K extends RestRouteId> = Route<K>['query'] extends z.ZodType
  ? z.output<Route<K>['query']>
  : never;
export type BodyOf<K extends RestRouteId> = Route<K>['body'] extends z.ZodType
  ? z.output<Route<K>['body']>
  : never;
export type ParamsOf<K extends RestRouteId> = Route<K>['params'] extends z.ZodType
  ? z.output<Route<K>['params']>
  : never;

export function parse<T extends z.ZodType>(schema: T | null, value: unknown, what: string): z.output<T> {
  if (schema === null) throw new BadRequestException(what + ' is not accepted');
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new BadRequestException(
      what +
        ': ' +
        parsed.error.issues
          .map((i) => (i.path.length > 0 ? i.path.join('.') + ' ' : '') + i.message)
          .join('; '),
    );
  return parsed.data;
}

/** Runs one route in its span, counting and timing it by route id and outcome status. */
export async function runRoute<T>(
  metrics: MetricsService,
  route: RestRouteId,
  request: AuthenticatedRequest,
  work: (principal: Principal) => Promise<T>,
): Promise<T> {
  const started = Date.now();
  let status = REST_ROUTES[route].status;
  try {
    const principal = request.principal;
    if (principal === undefined)
      throw new HttpException('a bearer token is required', HttpStatus.UNAUTHORIZED);
    return await withSpan(
      TRACER_NAME,
      'rest.' + route,
      { 'openmap.tenant': principal.tenantId, 'http.route': REST_ROUTES[route].path },
      () => work(principal),
    );
  } catch (err) {
    status = err instanceof HttpException ? err.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    throw err;
  } finally {
    metrics.restRequests.inc({ route, status: String(status) });
    metrics.restDuration.observe({ route }, (Date.now() - started) / TIME.msPerSecond);
  }
}
