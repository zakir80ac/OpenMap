// REQ-CORE-012 — outbox module: transactional event emission and the in-process bus.
import { Global, Module } from '@nestjs/common';
import { EventBus } from './event-bus.js';
import { OutboxService } from './outbox.service.js';

@Global()
@Module({ providers: [EventBus, OutboxService], exports: [EventBus, OutboxService] })
export class OutboxModule {}
