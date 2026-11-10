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

/**
 * REQ-SEC-011 (ADR-067 step 4) — field encryption through OpenBao Transit, for the personal data that must stay
 * protected from anyone who can query the database and in `pg_dump` output: vendor contacts, asset custodians, custom
 * fields marked sensitive. The key never leaves OpenBao; a stored value is the Transit ciphertext (`vault:v<n>:…`).
 * A value without the prefix was written before encryption: `decrypt` returns it as it is, and `isCiphertext` lets a
 * backfill find it. Such fields cannot be searched, filtered or sorted in the database.
 */
export interface FieldCipher {
  encrypt(values: readonly (string | null)[]): Promise<(string | null)[]>;
  decrypt(values: readonly (string | null)[]): Promise<(string | null)[]>;
}

export function isCiphertext(value: string): boolean {
  return value.startsWith(VAULT.ciphertextPrefix);
}

const encryptSchema = z.object({ data: z.object({ batch_results: z.array(z.object({ ciphertext: z.string().min(1) })) }) });
const decryptSchema = z.object({ data: z.object({ batch_results: z.array(z.object({ plaintext: z.string() })) }) });

export function createFieldCipher(
  env: Pick<Env, 'OPENBAO_ADDR'>,
  provider: VaultTokenProvider,
  fetchImpl: typeof fetch = fetch,
): FieldCipher {
  const url = (op: 'encrypt' | 'decrypt'): URL =>
    new URL('v1/' + VAULT.transitMount + '/' + op + '/' + VAULT.fieldKey, base(env.OPENBAO_ADDR));

  const call = async (op: 'encrypt' | 'decrypt', items: readonly { plaintext?: string; ciphertext?: string }[]): Promise<unknown> => {
    let res: Response;
    try {
      res = await vaultRequest(provider, fetchImpl, url(op), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ batch_input: items }),
      });
    } catch (err) {
      if (err instanceof VaultUnavailableError) throw err;
      throw new VaultUnavailableError('OpenBao unreachable: ' + (err instanceof Error ? err.message : String(err)));
    }
    if (!res.ok) throw new VaultUnavailableError('OpenBao refused a Transit ' + op + ': HTTP ' + String(res.status));
    return res.json();
  };

  /** Runs `work` over the indices that hold a value, in batches, and writes the results back in place. */
  const each = async (
    values: readonly (string | null)[],
    pick: (v: string) => boolean,
    work: (batch: string[]) => Promise<string[]>,
  ): Promise<(string | null)[]> => {
    const out = [...values];
    const indices = values.flatMap((v, i) => (v !== null && pick(v) ? [i] : []));
    for (let start = 0; start < indices.length; start += VAULT.transitBatch) {
      const slice = indices.slice(start, start + VAULT.transitBatch);
      const results = await work(slice.map((i) => values[i] as string));
      slice.forEach((i, k) => {
        out[i] = results[k] ?? null;
      });
    }
    return out;
  };

  return {
    encrypt: (values) =>
      each(values, (v) => !isCiphertext(v), async (batch) => {
        const parsed = encryptSchema.parse(await call('encrypt', batch.map((v) => ({ plaintext: Buffer.from(v, 'utf8').toString('base64') }))));
        if (parsed.data.batch_results.length !== batch.length) throw new VaultUnavailableError('OpenBao Transit returned a short batch');
        return parsed.data.batch_results.map((r) => r.ciphertext);
      }),
    decrypt: (values) =>
      each(values, isCiphertext, async (batch) => {
        const parsed = decryptSchema.parse(await call('decrypt', batch.map((v) => ({ ciphertext: v }))));
        if (parsed.data.batch_results.length !== batch.length) throw new VaultUnavailableError('OpenBao Transit returned a short batch');
        return parsed.data.batch_results.map((r) => Buffer.from(r.plaintext, 'base64').toString('utf8'));
      }),
  };
}
