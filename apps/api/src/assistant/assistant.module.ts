// REQ-AI-001 REQ-AI-007 REQ-AI-008 — assistant bounded context: the conversational pipeline, its skills over the
// CMDB, the services module, the dependency graph and the analytics store, and the persisted conversations.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { DbModule } from '../db/db.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { ServicesModule } from '../services/services.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { AssistantResolver, ConversationResolver } from './assistant.resolver.js';
import { AssistantService } from './assistant.service.js';
import { AssistantCatalogueService } from './catalogue.service.js';
import { CONVERSATIONS_REPOSITORY, PrismaConversationsRepository } from './conversations.repository.js';
import { ConversationsService } from './conversations.service.js';
import { EntityResolver } from './entity.resolver.js';
import { AttributesSkill } from './skills/attributes.skill.js';
import { GraphSkill } from './skills/graph.skill.js';
import { MetricsSkill } from './skills/metrics.skill.js';
import { ServicesSkill } from './skills/services.skill.js';

@Module({
  imports: [CiModule, DbModule, GraphModule, MetricsModule, ServicesModule, TenantModule],
  providers: [
    AssistantCatalogueService,
    EntityResolver,
    AttributesSkill,
    MetricsSkill,
    ServicesSkill,
    GraphSkill,
    { provide: CONVERSATIONS_REPOSITORY, useClass: PrismaConversationsRepository },
    ConversationsService,
    AssistantService,
    AssistantResolver,
    ConversationResolver,
  ],
})
export class AssistantModule {}
