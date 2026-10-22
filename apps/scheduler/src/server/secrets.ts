// REQ-SEC-002 — credential resolution from OpenBao KV v2. The scheduler holds the vault token; Nodes
// receive a short-lived in-memory copy of one credential per job and never the token.
import { z } from 'zod';
import { CREDENTIAL_REF_PATTERN } from '@openmap/constants';
import type { Env } from '@openmap/config';

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
export function createOpenBaoReader(env: Pick<Env, 'OPENBAO_ADDR' | 'OPENBAO_TOKEN' | 'OPENBAO_MOUNT'>, fetchImpl: typeof fetch = fetch): SecretsReader {
  return {
    async read(ref) {
      if (!CREDENTIAL_REF_PATTERN.test(ref) || ref.includes('..')) throw new Error('credential reference has unexpected characters');
      const url = new URL('v1/' + env.OPENBAO_MOUNT + '/data/' + ref.replace(/^\/+/, ''), env.OPENBAO_ADDR.endsWith('/') ? env.OPENBAO_ADDR : env.OPENBAO_ADDR + '/');
      const res = await fetchImpl(url, { headers: { 'X-Vault-Token': env.OPENBAO_TOKEN, accept: 'application/json' } });
      if (!res.ok) throw new Error('OpenBao returned ' + String(res.status) + ' for ' + ref);
      const parsed = kvResponseSchema.parse(await res.json());
      const { type, expiresAt, ...fields } = parsed.data.data;
      if (!type) throw new Error('credential ' + ref + ' has no type field');
      return { type, fields, expiresAt: expiresAt ?? null };
    },
  };
}
