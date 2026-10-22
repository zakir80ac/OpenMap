// REQ-CORE-012 — metrics module: exposes the registry at METRICS_PATH and installs the Mercurius hooks
// once the GraphQL plugin is registered.
import { Inject, Module, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import { ENV, type Env } from '../config/env.module.js';
import { registerGraphqlMetricsHooks } from './graphql-metrics.hook.js';
import { MetricsService } from './metrics.service.js';

@Module({ providers: [MetricsService], exports: [MetricsService] })
export class MetricsModule implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    private readonly metrics: MetricsService,
    private readonly adapterHost: HttpAdapterHost,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private get fastify(): FastifyInstance {
    return this.adapterHost.httpAdapter.getInstance<FastifyInstance>();
  }

  onModuleInit(): void {
    const metrics = this.metrics;
    this.fastify.get(this.env.METRICS_PATH, async (_request, reply) => {
      reply.header('content-type', metrics.contentType);
      return metrics.render();
    });
  }

  onApplicationBootstrap(): void {
    registerGraphqlMetricsHooks(this.fastify, this.metrics);
  }
}
