// REQ-AI-001 — assistant bounded context.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { AssistantResolver } from './assistant.resolver.js';
import { AssistantService } from './assistant.service.js';

@Module({ imports: [CiModule], providers: [AssistantService, AssistantResolver] })
export class AssistantModule {}
