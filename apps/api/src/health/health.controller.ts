// REQ-CORE-012 — REST liveness (/healthz) and readiness (/readyz) probes; public by design so
// orchestrators can poll them without a token.
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../auth/public.decorator.js';
import { HealthService, type Readiness } from './health.service.js';

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @Get('healthz')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('readyz')
  async readiness(@Res() reply: FastifyReply): Promise<void> {
    const result: Readiness = await this.health.readiness();
    await reply.code(result.status === 'ready' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).send(result);
  }
}
