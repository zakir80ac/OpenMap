// REQ-INT-007 — delivery engine: sends a payload to a remote system with retries and records every
// attempt as an IntegrationDelivery; exhausted retries go to the dead letter state. Secrets are
// resolved by the caller from OpenBao and passed as headers; nothing here reads the vault.
import { createHash, randomUUID } from 'node:crypto';
import { DISCOVERY, HTTP } from '@openmap/constants';
import type { IntegrationConfig, IntegrationDelivery } from '@openmap/contracts';

export interface DeliveryRequest {
  config: IntegrationConfig;
  /** Path appended to the integration endpoint, e.g. /api/now/table/incident. */
  path: string;
  method: 'POST' | 'PUT' | 'PATCH';
  headers: Record<string, string>;
  body: Record<string, unknown> | Array<Record<string, unknown>>;
  eventId: string | null;
}

export interface DeliveryOutcome {
  delivery: IntegrationDelivery;
  /** Parsed JSON body of the final response, when any. */
  response: Record<string, unknown> | null;
  /** Remote record id extracted from the response via `settings.remoteIdPath`, when configured. */
  remoteId: string | null;
}

export interface DeliveryDeps {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => string;
}

const RETRYABLE_STATUS = new Set<number>(HTTP.retryableStatuses);

export function digestOf(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function extract(path: string | undefined, response: Record<string, unknown> | null): string | null {
  if (!path || !response) return null;
  const v = path
    .split('.')
    .reduce<unknown>(
      (acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined),
      response,
    );
  return v === undefined || v === null ? null : String(v);
}

export async function deliver(req: DeliveryRequest, deps: DeliveryDeps): Promise<DeliveryOutcome> {
  // No path: the endpoint is the full address (a webhook URL), posted to exactly as configured.
  const url =
    req.path === ''
      ? new URL(req.config.endpoint).toString()
      : new URL(
          req.path,
          req.config.endpoint.endsWith('/') ? req.config.endpoint : req.config.endpoint + '/',
        ).toString();
  const requestDigest = digestOf(req.body);
  const delivery: IntegrationDelivery = {
    id: randomUUID(),
    integrationId: req.config.id,
    tenantId: req.config.tenantId,
    direction: 'out',
    eventId: req.eventId,
    remoteId: null,
    state: 'pending',
    attempts: 0,
    requestDigest,
    responseCode: null,
    error: null,
    createdAt: deps.now(),
    completedAt: null,
  };
  let response: Record<string, unknown> | null = null;
  const maxAttempts = DISCOVERY.retryBackoffMs.length + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    delivery.attempts = attempt + 1;
    try {
      const res = await deps.fetchImpl(url, {
        method: req.method,
        headers: { 'content-type': 'application/json', accept: 'application/json', ...req.headers },
        body: JSON.stringify(req.body),
      });
      delivery.responseCode = res.status;
      const text = await res.text();
      response = text.length ? (JSON.parse(text) as Record<string, unknown>) : null;
      if (res.ok) {
        delivery.state = 'delivered';
        delivery.completedAt = deps.now();
        delivery.remoteId = extract(
          typeof req.config.settings['remoteIdPath'] === 'string'
            ? req.config.settings['remoteIdPath']
            : undefined,
          response,
        );
        return { delivery, response, remoteId: delivery.remoteId };
      }
      delivery.error = 'HTTP ' + String(res.status);
      if (!RETRYABLE_STATUS.has(res.status)) break;
    } catch (err) {
      delivery.error = err instanceof Error ? err.message : String(err);
    }
    const backoff = DISCOVERY.retryBackoffMs[attempt];
    if (backoff === undefined) break;
    delivery.state = 'retrying';
    await deps.sleep(backoff);
  }
  delivery.state = delivery.attempts >= maxAttempts ? 'dead_letter' : 'failed';
  delivery.completedAt = deps.now();
  return { delivery, response, remoteId: null };
}
