// REQ-INT-005 REQ-SEC-011 — credential resolution from OpenBao KV v2 over HTTP. Adapters receive ready-made
// headers; secret values never reach a log, a row or a GraphQL response. The service authenticates with its AppRole
// (ADR-067); a refused token is dropped and the request tried once more with a fresh login.
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { HTTP, VAULT } from '@openmap/constants';
import { createVaultTokenProvider, type VaultTokenProvider } from '@openmap/vault';
import { z } from 'zod';
import { baseUrl } from '../auth/jwks.provider.js';
import { ENV, type Env } from '../config/env.module.js';

const kvResponseSchema = z.object({ data: z.object({ data: z.record(z.string(), z.unknown()) }) });

export type Secret = Record<string, string>;

const DEFAULT_API_KEY_HEADER = 'X-API-Key';

@Injectable()
export class SecretsService {
  /** Replaceable for tests; the global fetch in production. */
  fetchImpl: typeof fetch = fetch;

  private readonly vault: VaultTokenProvider;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.vault = createVaultTokenProvider(env, (input, init) => this.fetchImpl(input, init));
  }

  /** One request to the vault with the current token; after a 403 the token is dropped and the request sent once more. */
  private async call(
    url: URL,
    init: { method?: string; body?: string; contentType?: boolean } = {},
  ): Promise<Response> {
    const send = async (): Promise<Response> => {
      const headers: Record<string, string> = {
        [VAULT.tokenHeader]: await this.vault.token(),
        accept: 'application/json',
      };
      if (init.contentType === true) headers['content-type'] = 'application/json';
      return this.fetchImpl(url, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
      });
    };
    try {
      const first = await send();
      if (first.status !== HTTP.status.forbidden) return first;
      this.vault.invalidate();
      return await send();
    } catch (err) {
      throw new ServiceUnavailableException(
        'secrets store unreachable: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /** `ref` is the path below the KV v2 mount, e.g. `itsm/servicenow`. */
  kvUrl(ref: string): URL {
    return new URL(
      'v1/' + this.env.OPENBAO_MOUNT + '/data/' + ref.replace(/^\/+/, ''),
      baseUrl(this.env.OPENBAO_ADDR),
    );
  }

  async read(ref: string): Promise<Secret> {
    const res = await this.call(this.kvUrl(ref));
    if (!res.ok)
      throw new ServiceUnavailableException(
        'secrets store returned HTTP ' + String(res.status) + ' for ' + ref,
      );
    const parsed = kvResponseSchema.safeParse(await res.json());
    if (!parsed.success) throw new ServiceUnavailableException('secret ' + ref + ' is not a KV v2 record');
    const out: Secret = {};
    for (const [k, v] of Object.entries(parsed.data.data.data)) if (typeof v === 'string') out[k] = v;
    return out;
  }

  /** The KV v2 mount's management endpoint. */
  mountUrl(): URL {
    return new URL('v1/sys/mounts/' + this.env.OPENBAO_MOUNT, baseUrl(this.env.OPENBAO_ADDR));
  }

  /**
   * REQ-UI-024 (ADR-017) — writes a KV v2 record under `ref` (a new version when one exists). Values pass through
   * this process once, from the request to the vault; nothing keeps them. A fresh vault has no mount of OpenMap's
   * name yet: the first write creates it (KV version 2), so a new deployment needs no manual vault step.
   */
  async write(ref: string, data: Record<string, string>): Promise<void> {
    const first = await this.post(this.kvUrl(ref), { data });
    if (first.ok) return;
    if (first.status !== HTTP.status.notFound)
      throw new ServiceUnavailableException(
        'secrets store returned HTTP ' + String(first.status) + ' writing ' + ref,
      );
    await this.ensureMount();
    const second = await this.post(this.kvUrl(ref), { data });
    if (!second.ok)
      throw new ServiceUnavailableException(
        'secrets store returned HTTP ' + String(second.status) + ' writing ' + ref,
      );
  }

  /** Enables the KV v2 engine at the configured mount; an existing mount is left alone. */
  async ensureMount(): Promise<void> {
    const res = await this.post(this.mountUrl(), { type: 'kv', options: { version: '2' } });
    if (res.ok) return;
    const body = await res.text();
    if (res.status === HTTP.status.badRequest && body.includes('already in use')) return;
    throw new ServiceUnavailableException(
      'secrets store returned HTTP ' + String(res.status) + ' enabling mount ' + this.env.OPENBAO_MOUNT,
    );
  }

  private post(url: URL, body: unknown): Promise<Response> {
    return this.call(url, { method: 'POST', body: JSON.stringify(body), contentType: true });
  }

  /** The record under `ref` described without its values: field names and the contract type it names; null when absent. */
  async describe(ref: string): Promise<{ type: string | null; fields: string[] } | null> {
    const res = await this.call(this.kvUrl(ref));
    if (res.status === HTTP.status.notFound) return null;
    if (!res.ok)
      throw new ServiceUnavailableException(
        'secrets store returned HTTP ' + String(res.status) + ' for ' + ref,
      );
    const parsed = kvResponseSchema.safeParse(await res.json());
    if (!parsed.success) throw new ServiceUnavailableException('secret ' + ref + ' is not a KV v2 record');
    const typeValue = parsed.data.data.data['type'];
    return {
      type: typeof typeValue === 'string' ? typeValue : null,
      fields: Object.keys(parsed.data.data.data),
    };
  }

  /** Builds HTTP auth headers from the conventional secret keys: token, username+password, or apiKey. */
  static authHeaders(secret: Secret): Record<string, string> {
    const bearer = secret['token'];
    if (bearer !== undefined) return { authorization: 'Bearer ' + bearer };
    const user = secret['username'];
    const pass = secret['password'];
    if (user !== undefined && pass !== undefined)
      return { authorization: 'Basic ' + Buffer.from(user + ':' + pass, 'utf8').toString('base64') };
    const apiKey = secret['apiKey'];
    if (apiKey !== undefined) return { [secret['apiKeyHeader'] ?? DEFAULT_API_KEY_HEADER]: apiKey };
    return {};
  }
}
