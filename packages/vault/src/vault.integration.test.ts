// T-573 REQ-SEC-011 (ADR-067) — the production OpenBao of the compose stack (server mode, Raft, static seal), from the
// host: with an operator token (OPENBAO_TOKEN, e.g. from .local/openbao-root-token) the test creates a throwaway
// AppRole on the openmap-services policy, writes its ids to files, and the provider logs in with them: a KV v2 write and
// read under the services' mount succeed, sys/mounts is refused (least privilege), Transit encrypts and decrypts a
// personal-data value with the openmap-fields key, and a revoked token is replaced by a new login.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadEnv } from '@openmap/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVaultTokenProvider, vaultRequest } from './index.js';

const env = loadEnv();
const operator = env.OPENBAO_TOKEN ?? '';
const role = 'itest-' + randomUUID().slice(0, 8);
const dir = mkdtempSync(join(tmpdir(), 'openmap-approle-'));
const base = (env.OPENBAO_ADDR.endsWith('/') ? env.OPENBAO_ADDR : env.OPENBAO_ADDR + '/') + 'v1/';

async function asOperator(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(new URL(base + path), {
    method,
    headers: { 'X-Vault-Token': operator, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('production OpenBao (integration)', () => {
  beforeAll(async () => {
    expect(operator, 'export OPENBAO_TOKEN with an operator token').not.toBe('');
    const created = await asOperator('POST', 'auth/approle/role/' + role, {
      token_policies: ['openmap-services'],
      token_ttl: '10m',
      secret_id_ttl: '10m',
    });
    expect(created.status).toBe(204);
    const roleId = (
      (await (await asOperator('GET', 'auth/approle/role/' + role + '/role-id')).json()) as {
        data: { role_id: string };
      }
    ).data.role_id;
    const secretId = (
      (await (await asOperator('POST', 'auth/approle/role/' + role + '/secret-id')).json()) as {
        data: { secret_id: string };
      }
    ).data.secret_id;
    writeFileSync(join(dir, 'role-id'), roleId + '\n');
    writeFileSync(join(dir, 'secret-id'), secretId + '\n');
  });

  afterAll(async () => {
    await asOperator('DELETE', 'auth/approle/role/' + role);
    await asOperator('DELETE', env.OPENBAO_MOUNT + '/metadata/itest/' + role);
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs sealed-safe in server mode with Raft storage', async () => {
    const status = (await (await fetch(new URL(base + 'sys/seal-status'))).json()) as {
      type: string;
      initialized: boolean;
      sealed: boolean;
      storage_type: string;
    };
    expect(status).toMatchObject({ type: 'static', initialized: true, sealed: false, storage_type: 'raft' });
  });

  it('logs a service in with AppRole and keeps it to the services policy', async () => {
    const vault = createVaultTokenProvider({
      ...env,
      OPENBAO_TOKEN: undefined,
      OPENBAO_ROLE_ID_FILE: join(dir, 'role-id'),
      OPENBAO_SECRET_ID_FILE: join(dir, 'secret-id'),
    });
    expect(vault.mode).toBe('approle');
    const path = new URL(base + env.OPENBAO_MOUNT + '/data/itest/' + role);
    const written = await vaultRequest(vault, fetch, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { type: 'token', token: 'itest' } }),
    });
    expect(written.status).toBe(200);
    const read = (await (await vaultRequest(vault, fetch, path)).json()) as {
      data: { data: Record<string, string> };
    };
    expect(read.data.data).toEqual({ type: 'token', token: 'itest' });
    expect((await vaultRequest(vault, fetch, new URL(base + 'sys/mounts'))).status).toBe(403);

    const plaintext = Buffer.from('alice@example.test').toString('base64');
    const encrypted = (await (
      await vaultRequest(vault, fetch, new URL(base + 'transit/encrypt/openmap-fields'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plaintext }),
      })
    ).json()) as { data: { ciphertext: string } };
    expect(encrypted.data.ciphertext).toMatch(/^vault:v\d+:/u);
    const decrypted = (await (
      await vaultRequest(vault, fetch, new URL(base + 'transit/decrypt/openmap-fields'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ciphertext: encrypted.data.ciphertext }),
      })
    ).json()) as { data: { plaintext: string } };
    expect(decrypted.data.plaintext).toBe(plaintext);

    // A revoked token is refused; the provider logs in again and the request goes through.
    const token = await vault.token();
    expect((await asOperator('POST', 'auth/token/revoke', { token })).status).toBe(204);
    expect((await vaultRequest(vault, fetch, path)).status).toBe(200);
    expect(await vault.token()).not.toBe(token);
  });
});
