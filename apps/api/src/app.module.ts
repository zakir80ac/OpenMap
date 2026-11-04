// REQ-CORE-012 — application root: one module per bounded context plus the Mercurius GraphQL driver
// serving packages/contracts/graphql/schema.graphql schema-first.
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { MercuriusDriver, type MercuriusDriverConfig } from '@nestjs/mercurius';
import { AssetsModule } from './assets/assets.module.js';
import { AssistantModule } from './assistant/assistant.module.js';
import { AnalyticsModule } from './analytics/analytics.module.js';
import { SoftwareModule } from './software/software.module.js';
import { AuditModule } from './audit/audit.module.js';
import { OnboardingModule } from './onboarding/onboarding.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AuthService } from './auth/auth.service.js';
import { CiLoaderFactory } from './ci/ci.loaders.js';
import { CiModule } from './ci/ci.module.js';
import { EnvModule } from './config/env.module.js';
import { DashboardsModule } from './dashboards/dashboards.module.js';
import { DbModule } from './db/db.module.js';
import { DcimModule } from './dcim/dcim.module.js';
import { DiscoveryModule } from './discovery/discovery.module.js';
import { GraphModule } from './graph/graph.module.js';
import { graphqlOptions } from './graphql/graphql-options.js';
import { HealthModule } from './health/health.module.js';
import { ImpactModule } from './impact/impact.module.js';
import { IntegrationsModule } from './integrations/integrations.module.js';
import { IpamModule } from './ipam/ipam.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { ScalarsModule } from './scalars/scalars.module.js';
import { ServicesModule } from './services/services.module.js';
import { SubscriptionsModule } from './subscriptions/subscriptions.module.js';
import { TenantModule } from './tenant/tenant.module.js';

@Module({
  imports: [
    EnvModule,
    DbModule,
    AuthModule,
    TenantModule,
    OutboxModule,
    ScalarsModule,
    MetricsModule,
    HealthModule,
    CiModule,
    GraphModule,
    ServicesModule,
    ImpactModule,
    AssetsModule,
    DashboardsModule,
    IpamModule,
    DcimModule,
    DiscoveryModule,
    IntegrationsModule,
    OnboardingModule,
    AssistantModule,
    SubscriptionsModule,
    AuditModule,
    AnalyticsModule,
    SoftwareModule,
    GraphQLModule.forRootAsync<MercuriusDriverConfig>({
      driver: MercuriusDriver,
      imports: [CiModule],
      inject: [AuthService, CiLoaderFactory],
      useFactory: (auth: AuthService, loaders: CiLoaderFactory) => graphqlOptions(auth, loaders),
    }),
  ],
})
export class AppModule {}
