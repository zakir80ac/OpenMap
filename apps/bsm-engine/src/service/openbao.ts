// REQ-SEC-002 REQ-INT-007 REQ-SEC-011 — integration credentials from OpenBao KV v2. The engine logs in with its AppRole
// (ADR-067); credentials are read per delivery and never persisted or logged.
import { z } from 'zod';
import { CREDENTIAL_REF_PATTERN } from '@openmap/constants';
import type { Env } from '@openmap/config';
import { createVaultTokenProvider, vaultRequest, type VaultEnv } from '@openmap/vault';
import type { SecretsReader } from './engine.js';

const kvResponseSchema = z.object({ data: z.object({ data: z.record(z.string(), z.string()) }) });

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
      const { type, ...fields } = parsed.data.data;
      return { type: type ?? 'password', fields };
    },
  };
}
