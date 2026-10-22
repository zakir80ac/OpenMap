// REQ-CORE-005 — event contract, version CONTRACT_VERSIONS.event.
// Envelope is the CloudEvents 1.0 JSON format with a required tenantid extension.
// Every cross-store write goes through the outbox as one of these events.
import { z } from 'zod';

export const EVENT_TYPES = [
  'openmap.ci.created',
  'openmap.ci.updated',
  'openmap.ci.retired',
  'openmap.relationship.created',
  'openmap.relationship.retired',
  'openmap.discovery.job.scheduled',
  'openmap.discovery.job.started',
  'openmap.discovery.job.completed',
  'openmap.discovery.job.failed',
  'openmap.discovery.node.registered',
  'openmap.discovery.node.heartbeat',
  'openmap.reconciliation.conflict',
  'openmap.bsm.health.changed',
  'openmap.bsm.sla.breached',
  'openmap.bsm.incident.correlated',
  'openmap.ipam.subnet.utilisation',
  'openmap.ipam.address.conflict',
  'openmap.dcim.power.threshold',
  'openmap.vulnerability.correlated',
  'openmap.licence.compliance.changed',
  'openmap.timetravel.snapshot.created',
  'openmap.assistant.query.answered',
  'openmap.audit.action',
  'openmap.incident.opened',
  'openmap.incident.updated',
  'openmap.incident.resolved',
  'openmap.impact.simulation.completed',
  'openmap.impact.validation.recorded',
  'openmap.integration.delivery.succeeded',
  'openmap.integration.delivery.failed',
  'openmap.integration.credential.expiring',
  'openmap.security.alert.received',
  'openmap.security.response.executed',
  'openmap.asset.stage.changed',
  'openmap.asset.warranty.expiring',
  'openmap.asset.eos.approaching',
  'openmap.plan.status.changed',
  'openmap.ci.labelled',
] as const;
export const eventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof eventTypeSchema>;

export const eventEnvelopeSchema = z.object({
  specversion: z.literal('1.0'),
  id: z.uuid(),
  /** URI of the emitting service, e.g. /openmap/reconciler. */
  source: z.string().min(1),
  type: eventTypeSchema,
  /** The CI, job, service or subnet the event is about. */
  subject: z.string().min(1),
  time: z.iso.datetime(),
  datacontenttype: z.literal('application/json'),
  /** URI of the JSON Schema for `data`, versioned with the contract. */
  dataschema: z.string().min(1),
  tenantid: z.uuid(),
  /** Correlation id propagated from the originating request or job. */
  traceparent: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/** Outbox row: the envelope plus delivery bookkeeping. Stores subscribe by `type` prefix. */
export const outboxRecordSchema = z.object({
  sequence: z.number().int().positive(),
  envelope: eventEnvelopeSchema,
  /** Targets still to acknowledge: postgres, memgraph, clickhouse, meilisearch, websocket. */
  pending: z.array(z.enum(['memgraph', 'clickhouse', 'meilisearch', 'websocket', 'bsm'])),
  attempts: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime().nullable(),
});
export type OutboxRecord = z.infer<typeof outboxRecordSchema>;
