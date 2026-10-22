// REQ-CORE-012 — Prisma client lifecycle: one client per process, bound to POSTGRES_URL.
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@openmap/db';
import { ENV, type Env } from '../config/env.module.js';

@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(ENV) env: Env) {
    this.client = createPrismaClient(env);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
