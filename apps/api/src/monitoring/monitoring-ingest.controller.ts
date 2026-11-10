// REQ-INT-012 (ADR-073) — POST /ingest/monitoring/:integrationId (and /:token for senders that can set only a URL):
// the inbound endpoint Alertmanager, Zabbix, Nagios / Icinga, Datadog, SolarWinds and Splunk post their native alert
// payloads to. Public to the bearer-token guard: the integration's own credential authenticates the request
// (MonitoringService). Answers 202 with what was accepted.
import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { HTTP, MONITORING, NOTIFICATION } from '@openmap/constants';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Public } from '../auth/public.decorator.js';
import { parseInput } from '../common/validation.js';
import { MonitoringService, type IngestReport } from './monitoring.service.js';

type RawRequest = FastifyRequest & { rawBody?: Buffer | string };

const paramsSchema = z.object({ integrationId: z.uuid(), token: z.string().min(1).optional() });

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function rawOf(request: RawRequest, body: unknown): string {
  const raw = request.rawBody;
  if (raw === undefined) return JSON.stringify(body ?? null);
  return typeof raw === 'string' ? raw : raw.toString('utf8');
}

@Controller(MONITORING.ingestPath)
export class MonitoringIngestController {
  constructor(private readonly service: MonitoringService) {}

  private receive(params: unknown, body: unknown, request: RawRequest): Promise<IngestReport> {
    const p = parseInput(paramsSchema, params, 'path');
    return this.service.ingest(p.integrationId, {
      body,
      rawBody: rawOf(request, body),
      authorization: header(request, 'authorization'),
      signature: header(request, NOTIFICATION.signatureHeader),
      timestamp: header(request, NOTIFICATION.timestampHeader),
      urlToken: p.token,
    });
  }

  @Public()
  @Post(':integrationId')
  @HttpCode(HTTP.status.accepted)
  ingest(@Param() params: unknown, @Body() body: unknown, @Req() request: RawRequest): Promise<IngestReport> {
    return this.receive(params, body, request);
  }

  @Public()
  @Post(':integrationId/:token')
  @HttpCode(HTTP.status.accepted)
  ingestWithUrlToken(@Param() params: unknown, @Body() body: unknown, @Req() request: RawRequest): Promise<IngestReport> {
    return this.receive(params, body, request);
  }
}
