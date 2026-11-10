// REQ-SEC-011 (ADR-067) — the OpenBao token every service presents. With AppRole files configured the provider logs in
// (role id and secret id read from the files the openbao-init job writes), keeps the token, and logs in again once
// VAULT.renewAtFraction of its lease has passed or after the vault refuses it; otherwise it uses OPENBAO_TOKEN as
// given (an operator, a host-side test, an external vault). The token never reaches a log.
import { readFile } from 'node:fs/promises';
import type { Env } from '@openmap/config';
import { TIME, VAULT } from '@openmap/constants';
import { z } from 'zod';

export type VaultEnv = Pick<
  Env,
  | 'OPENBAO_ADDR'
  | 'OPENBAO_TOKEN'
  | 'OPENBAO_ROLE_ID_FILE'
  | 'OPENBAO_SECRET_ID_FILE'
  | 'OPENBAO_APPROLE_MOUNT'
>;

export interface VaultTokenProvider {
  /** A token valid for the next request. */
  token(): Promise<string>;
  /** Forgets the token after the vault refused it (HTTP 403), so the next call logs in again. */
  invalidate(): void;
  /** How the provider authenticates: AppRole files, a given token, or nothing configured. */
  readonly mode: 'approle' | 'token' | 'none';
}

export class VaultUnavailableError extends Error {}

const loginSchema = z.object({
  auth: z.object({ client_token: z.string().min(1), lease_duration: z.number().int().min(0) }),
});

const FORBIDDEN = 403;

/** One request to the vault with the provider's token; a 403 drops the token and the request is sent once more. */
export async function vaultRequest(
  provider: VaultTokenProvider,
  fetchImpl: typeof fetch,
  url: URL,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const send = async (): Promise<Response> =>
    fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: { accept: 'application/json', ...init.headers, [VAULT.tokenHeader]: await provider.token() },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
  const first = await send();
  if (first.status !== FORBIDDEN) return first;
  provider.invalidate();
  return send();
}

function base(addr: string): string {
  return addr.endsWith('/') ? addr : addr + '/';
}

export function createVaultTokenProvider(
  env: VaultEnv,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): VaultTokenProvider {
  const roleFile = env.OPENBAO_ROLE_ID_FILE;
  const secretFile = env.OPENBAO_SECRET_ID_FILE;
  if (roleFile === undefined || secretFile === undefined) {
    const given = env.OPENBAO_TOKEN;
    return {
      mode: given === undefined ? 'none' : 'token',
      token: () =>
        given === undefined
          ? Promise.reject(
              new VaultUnavailableError(
                'no OpenBao credentials configured (OPENBAO_ROLE_ID_FILE and OPENBAO_SECRET_ID_FILE, or OPENBAO_TOKEN)',
              ),
            )
          : Promise.resolve(given),
      invalidate: () => undefined,
    };
  }
  let current: { token: string; renewAt: number } | null = null;
  let pending: Promise<string> | null = null;

  const login = async (): Promise<string> => {
    const [roleId, secretId] = await Promise.all([readFile(roleFile, 'utf8'), readFile(secretFile, 'utf8')]);
    let res: Response;
    try {
      res = await fetchImpl(
        new URL('v1/auth/' + env.OPENBAO_APPROLE_MOUNT + '/login', base(env.OPENBAO_ADDR)),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ role_id: roleId.trim(), secret_id: secretId.trim() }),
          signal: AbortSignal.timeout(VAULT.loginTimeoutMs),
        },
      );
    } catch (err) {
      throw new VaultUnavailableError(
        'OpenBao unreachable: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
    if (!res.ok)
      throw new VaultUnavailableError('OpenBao refused the AppRole login: HTTP ' + String(res.status));
    const parsed = loginSchema.parse(await res.json());
    const leaseMs = parsed.auth.lease_duration * TIME.msPerSecond;
    // A lease of 0 means the token does not expire; it is kept until the vault refuses it.
    current = {
      token: parsed.auth.client_token,
      renewAt: leaseMs === 0 ? Number.POSITIVE_INFINITY : now() + leaseMs * VAULT.renewAtFraction,
    };
    return parsed.auth.client_token;
  };

  return {
    mode: 'approle',
    token() {
      if (current !== null && now() < current.renewAt) return Promise.resolve(current.token);
      pending ??= login().finally(() => {
        pending = null;
      });
      return pending;
    },
    invalidate() {
      current = null;
    },
  };
}
