// REQ-INT-016 (ADR-074) — Keycloak admin REST client for identity federation. It signs in with the client-credentials
// grant of KEYCLOAK_ADMIN_CLIENT_ID when a secret is configured (a service account holding realm-management roles), or
// else with the password grant of KEYCLOAK_ADMIN, both in KEYCLOAK_ADMIN_REALM; the token is reused until shortly
// before it expires, and a refused token is dropped and the call sent once more. Calls go over the backchannel address
// (KEYCLOAK_URL) to the federation realm (IDENTITY_FEDERATION_REALM, or KEYCLOAK_REALM).
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { HTTP, IDENTITY_FEDERATION, TIME } from '@openmap/constants';
import { z } from 'zod';
import { baseUrl } from '../auth/jwks.provider.js';
import { ENV, type Env } from '../config/env.module.js';

const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() });
const errorSchema = z.object({
  errorMessage: z.string().optional(),
  error_description: z.string().optional(),
  error: z.string().optional(),
});

export interface KeycloakResponse {
  status: number;
  ok: boolean;
  /** The Location header of a create, naming the new object. */
  location: string | null;
  body: unknown;
}

/** A Keycloak answer other than the one expected; `status` 0 means Keycloak could not be reached. */
export class KeycloakError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'KeycloakError';
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface CallOptions {
  /** Statuses that count as success (default: every 2xx status). */
  expect?: readonly number[];
  timeoutMs?: number;
}

/** The realm identity sources are applied to. */
export function federationRealm(env: Pick<Env, 'IDENTITY_FEDERATION_REALM' | 'KEYCLOAK_REALM'>): string {
  return env.IDENTITY_FEDERATION_REALM === '' ? env.KEYCLOAK_REALM : env.IDENTITY_FEDERATION_REALM;
}

/** The id of the object a create returned, from its Location header (`…/components/<id>`). */
export function createdId(response: KeycloakResponse): string {
  const id = response.location?.split('/').pop() ?? '';
  if (id === '') throw new KeycloakError(response.status, 'Keycloak created an object without naming it (no Location header)');
  return id;
}

/** Keycloak's reason for a refusal, from whichever field its error body uses. */
export function keycloakReason(status: number, body: unknown): string {
  const parsed = errorSchema.safeParse(body);
  const reason = parsed.success ? (parsed.data.errorMessage ?? parsed.data.error_description ?? parsed.data.error) : undefined;
  return 'Keycloak answered HTTP ' + String(status) + (reason === undefined ? '' : ': ' + reason);
}

@Injectable()
export class KeycloakAdminClient {
  /** Replaceable for tests; the global fetch in production. */
  fetchImpl: typeof fetch = fetch;

  private cached: { token: string; renewAt: number } | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  get realm(): string {
    return federationRealm(this.env);
  }

  /** True when this deployment gave the API a way to sign in to Keycloak's admin API. */
  configured(): boolean {
    return this.env.KEYCLOAK_ADMIN_CLIENT_SECRET !== '' || (this.env.KEYCLOAK_ADMIN !== '' && this.env.KEYCLOAK_ADMIN_PASSWORD !== '');
  }

  private grant(): URLSearchParams {
    if (this.env.KEYCLOAK_ADMIN_CLIENT_SECRET !== '')
      return new URLSearchParams({ grant_type: 'client_credentials', client_id: this.env.KEYCLOAK_ADMIN_CLIENT_ID, client_secret: this.env.KEYCLOAK_ADMIN_CLIENT_SECRET });
    return new URLSearchParams({ grant_type: 'password', client_id: this.env.KEYCLOAK_ADMIN_CLIENT_ID, username: this.env.KEYCLOAK_ADMIN, password: this.env.KEYCLOAK_ADMIN_PASSWORD });
  }

  private async token(): Promise<string> {
    if (this.cached !== null && Date.now() < this.cached.renewAt) return this.cached.token;
    if (!this.configured())
      throw new ServiceUnavailableException('Keycloak administration is not configured (KEYCLOAK_ADMIN_CLIENT_SECRET, or KEYCLOAK_ADMIN and KEYCLOAK_ADMIN_PASSWORD)');
    const url = new URL('realms/' + encodeURIComponent(this.env.KEYCLOAK_ADMIN_REALM) + '/protocol/openid-connect/token', baseUrl(this.env.KEYCLOAK_URL));
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: this.grant().toString(),
        signal: AbortSignal.timeout(IDENTITY_FEDERATION.requestTimeoutMs),
      });
    } catch (err) {
      throw new KeycloakError(0, 'Keycloak unreachable: ' + (err instanceof Error ? err.message : String(err)));
    }
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new KeycloakError(res.status, 'Keycloak refused the admin sign-in. ' + keycloakReason(res.status, body));
    const parsed = tokenSchema.safeParse(body);
    if (!parsed.success) throw new KeycloakError(res.status, 'Keycloak returned no admin access token');
    this.cached = {
      token: parsed.data.access_token,
      renewAt: Date.now() + parsed.data.expires_in * TIME.msPerSecond - IDENTITY_FEDERATION.adminTokenMarginMs,
    };
    return parsed.data.access_token;
  }

  /** The admin URL of a path below the federation realm (`''` is the realm itself). */
  url(path: string): URL {
    return new URL('admin/realms/' + encodeURIComponent(this.realm) + path, baseUrl(this.env.KEYCLOAK_URL));
  }

  /** One admin call; any HTTP answer is returned, only an unreachable Keycloak throws. */
  async request(method: HttpMethod, path: string, body?: unknown, timeoutMs: number = IDENTITY_FEDERATION.requestTimeoutMs): Promise<KeycloakResponse> {
    const send = async (): Promise<Response> => {
      const headers: Record<string, string> = { authorization: 'Bearer ' + (await this.token()), accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      return this.fetchImpl(this.url(path), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    };
    let res: Response;
    try {
      res = await send();
      if (res.status === HTTP.status.unauthorized) {
        this.cached = null;
        res = await send();
      }
    } catch (err) {
      if (err instanceof KeycloakError || err instanceof ServiceUnavailableException) throw err;
      throw new KeycloakError(0, 'Keycloak unreachable: ' + (err instanceof Error ? err.message : String(err)));
    }
    const text = await res.text();
    let parsed: unknown = null;
    if (text !== '') {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, ok: res.ok, location: res.headers.get('location'), body: parsed };
  }

  /** An admin call that must succeed; Keycloak's reason becomes the error message. */
  async call(method: HttpMethod, path: string, body?: unknown, options: CallOptions = {}): Promise<KeycloakResponse> {
    const res = await this.request(method, path, body, options.timeoutMs);
    const accepted = options.expect === undefined ? res.ok : options.expect.includes(res.status);
    if (!accepted) throw new KeycloakError(res.status, method + ' ' + path + ' failed. ' + keycloakReason(res.status, res.body));
    return res;
  }
}
