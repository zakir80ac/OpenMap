// REQ-CORE-012 — transactional outbox. Every write runs inside `transaction()`; the callback emits
// CloudEvents envelopes that are inserted as outbox_events rows in the same Postgres transaction.
// After commit the envelopes are published on the in-process bus for WebSocket subscribers.
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { trace, TraceFlags } from '@opentelemetry/api';
import { CONTRACT_VERSIONS } from '@openmap/constants';
import { eventEnvelopeSchema, type EventEnvelope, type EventType } from '@openmap/contracts';
import type { Prisma } from '@openmap/db';
import { nowIso } from '../common/time.js';
import { PrismaService } from '../db/prisma.service.js';
import { EventBus } from './event-bus.js';
import { pendingTargets } from './targets.js';

/** CloudEvents `source` of this service. */
export const EVENT_SOURCE = '/openmap/api';

export interface OutboxDraft {
  type: EventType;
  /** The CI, job, service or subnet the event is about. */
  subject: string;
  data: Record<string, unknown>;
}

export interface OutboxTransaction {
  tx: Prisma.TransactionClient;
  emit(draft: OutboxDraft): Promise<EventEnvelope>;
}

export function dataSchemaUri(): string {
  return 'https://openmap.dev/contracts/event/' + CONTRACT_VERSIONS.event;
}

/** W3C traceparent of the active span, so consumers continue the trace. */
export function currentTraceparent(): string | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const ctx = span.spanContext();
  const sampled = (ctx.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED;
  return '00-' + ctx.traceId + '-' + ctx.spanId + (sampled ? '-01' : '-00');
}

export function buildEnvelope(tenantId: string, draft: OutboxDraft): EventEnvelope {
  const traceparent = currentTraceparent();
  const envelope: EventEnvelope = {
    specversion: '1.0',
    id: randomUUID(),
    source: EVENT_SOURCE,
    type: draft.type,
    subject: draft.subject,
    time: nowIso(),
    datacontenttype: 'application/json',
    dataschema: dataSchemaUri(),
    tenantid: tenantId,
    data: draft.data,
    ...(traceparent === undefined ? {} : { traceparent }),
  };
  return eventEnvelopeSchema.parse(envelope);
}

@Injectable()
export class OutboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  async transaction<T>(tenantId: string, fn: (ctx: OutboxTransaction) => Promise<T>): Promise<T> {
    const committed: EventEnvelope[] = [];
    const result = await this.prisma.client.$transaction(async (tx) => {
      const emit = async (draft: OutboxDraft): Promise<EventEnvelope> => {
        const envelope = buildEnvelope(tenantId, draft);
        await tx.outboxEvent.create({
          data: {
            eventId: envelope.id,
            tenantId,
            type: envelope.type,
            subject: envelope.subject,
            envelope: envelope as unknown as Prisma.InputJsonObject,
            pending: pendingTargets(envelope.type),
          },
        });
        committed.push(envelope);
        return envelope;
      };
      return fn({ tx, emit });
    });
    for (const e of committed) this.bus.publish(e);
    return result;
  }
}
