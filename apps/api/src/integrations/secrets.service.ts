// REQ-INT-005 — credential resolution from OpenBao KV v2 over HTTP. Adapters receive ready-made
// headers; secret values never reach a log, a row or a GraphQL response.
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { baseUrl } from '../auth/jwks.provider.js';
import { ENV, type Env } from '../config/env.module.js';

const kvResponseSchema = z.object({ data: z.object({ data: z.record(z.string(), z.unknown()) }) });

export type Secret = Record<string, string>;

const VAULT_TOKEN_HEADER = 'X-Vault-Token';
const DEFAULT_API_KEY_HEADER = 'X-API-Key';

@Injectable()
export class SecretsService {
  /** Replaceable for tests; the global fetch in production. */
  fetchImpl: typeof fetch = fetch;

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** `ref` is the path below the KV v2 mount, e.g. `itsm/servicenow`. */
  kvUrl(ref: string): URL {
    return new URL('v1/' + this.env.OPENBAO_MOUNT + '/data/' + ref.replace(/^\/+/, ''), baseUrl(this.env.OPENBAO_ADDR));
  }

  async read(ref: string): Promise<Secret> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.kvUrl(ref), { headers: { [VAULT_TOKEN_HEADER]: this.env.OPENBAO_TOKEN, accept: 'application/json' } });
    } catch (err) {
      throw new ServiceUnavailableException('secrets store unreachable: ' + (err instanceof Error ? err.message : String(err)));
    }
    if (!res.ok) throw new ServiceUnavailableException('secrets store returned HTTP ' + String(res.status) + ' for ' + ref);
    const parsed = kvResponseSchema.safeParse(await res.json());
    if (!parsed.success) throw new ServiceUnavailableException('secret ' + ref + ' is not a KV v2 record');
    const out: Secret = {};
    for (const [k, v] of Object.entries(parsed.data.data.data)) if (typeof v === 'string') out[k] = v;
    return out;
  }

  /** Builds HTTP auth headers from the conventional secret keys: token, username+password, or apiKey. */
  static authHeaders(secret: Secret): Record<string, string> {
    const bearer = secret['token'];
    if (bearer !== undefined) return { authorization: 'Bearer ' + bearer };
    const user = secret['username'];
    const pass = secret['password'];
    if (user !== undefined && pass !== undefined) return { authorization: 'Basic ' + Buffer.from(user + ':' + pass, 'utf8').toString('base64') };
    const apiKey = secret['apiKey'];
    if (apiKey !== undefined) return { [secret['apiKeyHeader'] ?? DEFAULT_API_KEY_HEADER]: apiKey };
    return {};
  }
}
