// REQ-CORE-012 — readiness checks: Postgres answers a trivial query and Memgraph answers a read.
import { Injectable } from '@nestjs/common';
import { GraphService } from '../db/graph.service.js';
import { PrismaService } from '../db/prisma.service.js';

export interface DependencyCheck {
  name: 'postgres' | 'memgraph';
  ok: boolean;
  error: string | null;
}

export interface Readiness {
  status: 'ready' | 'degraded';
  checks: DependencyCheck[];
}

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
  ) {}

  async readiness(): Promise<Readiness> {
    const checks = await Promise.all([
      this.check('postgres', async () => {
        await this.prisma.client.$queryRaw`SELECT 1`;
      }),
      this.check('memgraph', async () => {
        await this.graph.repo.readOnly('RETURN 1 AS ok', {});
      }),
    ]);
    return { status: checks.every((c) => c.ok) ? 'ready' : 'degraded', checks };
  }

  private async check(name: DependencyCheck['name'], fn: () => Promise<void>): Promise<DependencyCheck> {
    try {
      await fn();
      return { name, ok: true, error: null };
    } catch (err) {
      return { name, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
