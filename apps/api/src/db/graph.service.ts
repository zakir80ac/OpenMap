// REQ-CORE-012 — graph repository lifecycle: Memgraph by default through @openmap/graph.
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createGraphRepository, type GraphRepository } from '@openmap/graph';
import { ENV, type Env } from '../config/env.module.js';

@Injectable()
export class GraphService implements OnModuleDestroy {
  readonly repo: GraphRepository;

  constructor(@Inject(ENV) env: Env) {
    this.repo = createGraphRepository(env);
  }

  async onModuleDestroy(): Promise<void> {
    await this.repo.close();
  }
}
