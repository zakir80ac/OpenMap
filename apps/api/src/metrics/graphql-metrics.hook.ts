// REQ-CORE-012 — Mercurius hooks that time every GraphQL operation, record it in Prometheus and
// wrap it in an OpenTelemetry span. Pure helpers are exported so the hook logic is unit-tested.
import { trace, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import { TIME } from '@openmap/constants';
import type { DocumentNode, GraphQLError } from 'graphql';
import { Kind } from 'graphql';
import type { FastifyInstance } from 'fastify';
import type { MetricsService, RequestStatus } from './metrics.service.js';

export const ANONYMOUS_OPERATION = 'anonymous';
export const TRACER_NAME = 'openmap-api';

export function operationNameOf(document: DocumentNode): string {
  for (const def of document.definitions) {
    if (def.kind === Kind.OPERATION_DEFINITION) return def.name?.value ?? ANONYMOUS_OPERATION;
  }
  return ANONYMOUS_OPERATION;
}

export function operationTypeOf(document: DocumentNode): string {
  for (const def of document.definitions) {
    if (def.kind === Kind.OPERATION_DEFINITION) return def.operation;
  }
  return 'query';
}

export function statusOf(errors: readonly GraphQLError[] | null | undefined): RequestStatus {
  return errors && errors.length > 0 ? 'error' : 'ok';
}

export function elapsedSeconds(startedNs: bigint, endedNs: bigint): number {
  const nsPerSecond = TIME.msPerSecond * TIME.msPerSecond * TIME.msPerSecond;
  return Number(endedNs - startedNs) / nsPerSecond;
}

interface InFlight {
  operation: string;
  startedNs: bigint;
  span: Span;
}

/** Records one completed operation; shared by the Mercurius hook and its unit test. */
export function recordOperation(metrics: MetricsService, inFlight: InFlight, errors: readonly GraphQLError[] | null | undefined, endedNs: bigint): void {
  const status = statusOf(errors);
  metrics.observe(inFlight.operation, status, elapsedSeconds(inFlight.startedNs, endedNs));
  if (status === 'error') inFlight.span.setStatus({ code: SpanStatusCode.ERROR, message: errors?.[0]?.message ?? 'graphql error' });
  inFlight.span.setAttribute('graphql.errors', errors?.length ?? 0);
  inFlight.span.end();
}

interface ExecutionLike {
  errors?: readonly GraphQLError[] | null;
}

export function registerGraphqlMetricsHooks(app: FastifyInstance, metrics: MetricsService, tracer: Tracer = trace.getTracer(TRACER_NAME)): void {
  const inFlight = new WeakMap<object, InFlight>();
  app.graphql.addHook('preExecution', async (_schema, document, context) => {
    const operation = operationNameOf(document);
    const span = tracer.startSpan('graphql.' + operationTypeOf(document) + ' ' + operation);
    span.setAttribute('graphql.operation.name', operation);
    span.setAttribute('graphql.operation.type', operationTypeOf(document));
    inFlight.set(context, { operation, startedNs: process.hrtime.bigint(), span });
  });
  app.graphql.addHook('onResolution', async (execution: ExecutionLike, context) => {
    const entry = inFlight.get(context);
    if (!entry) return;
    inFlight.delete(context);
    recordOperation(metrics, entry, execution.errors, process.hrtime.bigint());
  });
}
