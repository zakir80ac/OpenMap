// REQ-CORE-005 — bridges the in-process event bus to Mercurius pub/sub: every committed envelope is
// published to the tenant's events topic; health and discovery events also fan out as typed views.
import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { EventEnvelope } from '@openmap/contracts';
import type { FastifyInstance } from 'fastify';
import { DiscoveryService } from '../discovery/discovery.service.js';
import { EventBus } from '../outbox/event-bus.js';
import { HEALTH_CHANGED } from '../services/services.repository.js';
import { ServicesService } from '../services/services.service.js';
import { eventsTopic, serviceHealthTopic, sweepTopic, type OpenMapPubSub } from './topics.js';

const DISCOVERY_JOB_PREFIX = 'openmap.discovery.job.';

@Injectable()
export class SubscriptionsPublisher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionsPublisher.name);
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly adapterHost: HttpAdapterHost,
    private readonly services: ServicesService,
    private readonly discovery: DiscoveryService,
  ) {}

  onApplicationBootstrap(): void {
    this.unsubscribe = this.bus.subscribe((envelope) => {
      void this.forward(envelope).catch((err: unknown) => this.logger.warn('subscription publish failed: ' + (err instanceof Error ? err.message : String(err))));
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  private get pubsub(): OpenMapPubSub {
    return this.adapterHost.httpAdapter.getInstance<FastifyInstance>().graphql.pubsub as OpenMapPubSub;
  }

  async forward(envelope: EventEnvelope): Promise<void> {
    const tenantId = envelope.tenantid;
    this.pubsub.publish({ topic: eventsTopic(tenantId), payload: { events: envelope } });
    if (envelope.type === HEALTH_CHANGED) {
      const view = await this.services.healthViewById(tenantId, envelope.subject);
      if (view) this.pubsub.publish({ topic: serviceHealthTopic(tenantId), payload: { serviceHealthChanged: view } });
    }
    if (envelope.type.startsWith(DISCOVERY_JOB_PREFIX)) {
      const sweepId = envelope.data['sweepId'];
      if (typeof sweepId === 'string') {
        const sweep = await this.discovery.sweep(tenantId, sweepId);
        this.pubsub.publish({ topic: sweepTopic(tenantId), payload: { sweepProgress: sweep } });
      }
    }
  }
}
