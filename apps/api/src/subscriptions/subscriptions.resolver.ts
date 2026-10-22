// REQ-CORE-005 — Subscription.events / serviceHealthChanged / sweepProgress over Mercurius WebSocket.
// The connection's verified principal picks the tenant topic; `events(types)` filters in-stream.
import { UnauthorizedException } from '@nestjs/common';
import { Args, Context, Resolver, Subscription } from '@nestjs/graphql';
import { z } from 'zod';
import { parseInput } from '../common/validation.js';
import type { GqlContext } from '../graphql/context.js';
import { eventsTopic, serviceHealthTopic, sweepTopic, type EventsPayload, type OpenMapPubSub, type ServiceHealthPayload, type SweepPayload } from './topics.js';

export type SubscriptionContext = GqlContext & { pubsub: OpenMapPubSub };

const typesArg = z.array(z.string().min(1)).nullish();

function tenantOf(ctx: SubscriptionContext): string {
  if (ctx.principal === null) throw new UnauthorizedException('a bearer token is required');
  return ctx.principal.tenantId;
}

export async function* filteredEvents(source: AsyncIterable<EventsPayload>, types: readonly string[] | null): AsyncGenerator<EventsPayload> {
  for await (const payload of source) {
    if (types === null || types.length === 0 || types.includes(payload.events.type)) yield payload;
  }
}

@Resolver()
export class SubscriptionsResolver {
  @Subscription('events')
  async events(@Args('types') types: unknown, @Context() ctx: SubscriptionContext): Promise<AsyncIterable<EventsPayload>> {
    const wanted = parseInput(typesArg, types, 'event types') ?? null;
    const source = await ctx.pubsub.subscribe(eventsTopic(tenantOf(ctx)));
    return filteredEvents(source, wanted);
  }

  @Subscription('serviceHealthChanged')
  serviceHealthChanged(@Context() ctx: SubscriptionContext): Promise<AsyncIterable<ServiceHealthPayload>> {
    return ctx.pubsub.subscribe(serviceHealthTopic(tenantOf(ctx)));
  }

  @Subscription('sweepProgress')
  sweepProgress(@Context() ctx: SubscriptionContext): Promise<AsyncIterable<SweepPayload>> {
    return ctx.pubsub.subscribe(sweepTopic(tenantOf(ctx)));
  }
}
