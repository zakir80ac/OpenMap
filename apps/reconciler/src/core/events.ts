// REQ-CORE-005 REQ-CORE-013 — builds outbox envelopes for every reconciliation outcome.
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSIONS } from '@openmap/constants';
import { eventEnvelopeSchema, type EventEnvelope, type EventType } from '@openmap/contracts';

export const RECONCILER_SOURCE = '/openmap/reconciler';

export function envelope(tenantId: string, type: EventType, subject: string, data: Record<string, unknown>, traceparent?: string): EventEnvelope {
  const base = {
    specversion: '1.0' as const,
    id: randomUUID(),
    source: RECONCILER_SOURCE,
    type,
    subject,
    time: new Date().toISOString(),
    datacontenttype: 'application/json' as const,
    dataschema: 'openmap/contracts/event/' + CONTRACT_VERSIONS.event,
    tenantid: tenantId,
    data,
  };
  return eventEnvelopeSchema.parse(traceparent === undefined ? base : { ...base, traceparent });
}
