// REQ-CORE-005 — WebSocket subscriptions bounded context.
import { Module } from '@nestjs/common';
import { DiscoveryModule } from '../discovery/discovery.module.js';
import { ServicesModule } from '../services/services.module.js';
import { SubscriptionsPublisher } from './subscriptions.publisher.js';
import { SubscriptionsResolver } from './subscriptions.resolver.js';

@Module({ imports: [ServicesModule, DiscoveryModule], providers: [SubscriptionsResolver, SubscriptionsPublisher] })
export class SubscriptionsModule {}
