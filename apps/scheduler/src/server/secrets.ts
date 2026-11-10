// REQ-SEC-002 REQ-SEC-011 — credential resolution from OpenBao KV v2. The scheduler logs in with its AppRole (ADR-067);
// Nodes receive a short-lived in-memory copy of one credential per job and never a vault token.
import { z } from 'zod';
import { CREDENTIAL_REF_PATTERN } from '@openmap/constants';
import type { Env } from '@openmap/config';
import { createVaultTokenProvider, vaultRequest, type VaultEnv } from '@openmap/vault';

const kvResponseSchema = z.object({
  data: z.object({
    data: z.record(z.string(), z.string()),
    metadata: z.object({ version: z.number(), created_time: z.string() }).partial(),
  }),
});

export interface ResolvedCredential {
  type: string;
  fields: Record<string, string>;
  expiresAt: string | null;
}

export interface SecretsReader {
  read(ref: string): Promise<ResolvedCredential>;
}

/** Credential fields are stored under the ref path with a `type` key naming the contract credential type. */
export function createOpenBaoReader(
  env: VaultEnv & Pick<Env, 'OPENBAO_MOUNT'>,
  fetchImpl: typeof fetch = fetch,
): SecretsReader {
  const vault = createVaultTokenProvider(env, fetchImpl);
  return {
    async read(ref) {
      if (!CREDENTIAL_REF_PATTERN.test(ref) || ref.includes('..'))
        throw new Error('credential reference has unexpected characters');
      const url = new URL(
        'v1/' + env.OPENBAO_MOUNT + '/data/' + ref.replace(/^\/+/, ''),
        env.OPENBAO_ADDR.endsWith('/') ? env.OPENBAO_ADDR : env.OPENBAO_ADDR + '/',
      );
      const res = await vaultRequest(vault, fetchImpl, url);
      if (!res.ok) throw new Error('OpenBao returned ' + String(res.status) + ' for ' + ref);
      const parsed = kvResponseSchema.parse(await res.json());
      const { type, expiresAt, ...fields } = parsed.data.data;
      if (!type) throw new Error('credential ' + ref + ' has no type field');
      return { type, fields, expiresAt: expiresAt ?? null };
    },
  };
}
