// REQ-CORE-005 — pub/sub topic names, scoped per tenant so one tenant never sees another's events,
// and the typed topic map that makes Mercurius publish/subscribe payloads type-checked.
import type { EventEnvelope } from '@openmap/contracts';
import type { PubSub } from 'mercurius';
import type { SweepView } from '../discovery/discovery.types.js';
import type { ServiceHealthView } from '../services/services.types.js';

export type EventsTopic = `events:${string}`;
export type ServiceHealthTopic = `serviceHealthChanged:${string}`;
export type SweepTopic = `sweepProgress:${string}`;

export interface EventsPayload {
  events: EventEnvelope;
}
export interface ServiceHealthPayload {
  serviceHealthChanged: ServiceHealthView;
}
export interface SweepPayload {
  sweepProgress: SweepView;
}

export interface OpenMapTopics {
  [topic: EventsTopic]: EventsPayload;
  [topic: ServiceHealthTopic]: ServiceHealthPayload;
  [topic: SweepTopic]: SweepPayload;
}

export type OpenMapPubSub = PubSub<OpenMapTopics>;

export function eventsTopic(tenantId: string): EventsTopic {
  return `events:${tenantId}`;
}

export function serviceHealthTopic(tenantId: string): ServiceHealthTopic {
  return `serviceHealthChanged:${tenantId}`;
}

export function sweepTopic(tenantId: string): SweepTopic {
  return `sweepProgress:${tenantId}`;
}
