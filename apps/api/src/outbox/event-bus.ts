// REQ-CORE-012 — in-process event bus. The outbox service publishes every committed envelope here;
// the subscriptions module forwards them to WebSocket clients.
import { EventEmitter } from 'node:events';
import { Injectable } from '@nestjs/common';
import type { EventEnvelope } from '@openmap/contracts';

const TOPIC = 'event';

export type EventListener = (envelope: EventEnvelope) => void;

@Injectable()
export class EventBus {
  private readonly emitter = new EventEmitter();

  publish(envelope: EventEnvelope): void {
    this.emitter.emit(TOPIC, envelope);
  }

  /** Subscribes; the returned function unsubscribes. */
  subscribe(listener: EventListener): () => void {
    this.emitter.on(TOPIC, listener);
    return () => this.emitter.off(TOPIC, listener);
  }
}
