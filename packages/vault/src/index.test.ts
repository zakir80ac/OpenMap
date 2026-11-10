// T-572 REQ-SEC-011 (ADR-067) — the OpenBao token provider: AppRole login with the ids read from files, the token
// reused until VAULT.renewAtFraction of its lease and a new login after; concurrent callers share one login; a refused
// token is forgotten; OPENBAO_TOKEN as given when no AppRole files are configured; a clear error when nothing is.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { VaultUnavailableError, createVaultTokenProvider } from './index.js';

const dir = mkdtempSync(join(tmpdir(), 'openmap-vault-'));
writeFileSync(join(dir, 'role-id'), 'role-123\n');
writeFileSync(join(dir, 'secret-id'), 'secret-456\n');
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const env = {
  OPENBAO_ADDR: 'http://bao.test:8200',
  OPENBAO_TOKEN: undefined,
  OPENBAO_ROLE_ID_FILE: join(dir, 'role-id'),
  OPENBAO_SECRET_ID_FILE: join(dir, 'secret-id'),
  OPENBAO_APPROLE_MOUNT: 'approle',
};

function bao(leaseSeconds: number) {
  const calls: Array<{ url: string; body: string }> = [];
  let n = 0;
  const fetchImpl = ((url: URL, init: RequestInit) => {
    calls.push({ url: url.toString(), body: String(init.body) });
    n += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({ auth: { client_token: 'tok-' + String(n), lease_duration: leaseSeconds } }),
        { status: 200 },
      ),
    );
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('OpenBao token provider', () => {
  it('logs in with AppRole, reuses the token until three quarters of the lease, then logs in again', async () => {
    let clock = 1_000_000;
    const b = bao(3600);
    const provider = createVaultTokenProvider(env, b.fetchImpl, () => clock);
    expect(provider.mode).toBe('approle');
    expect(await provider.token()).toBe('tok-1');
    expect(b.calls[0]).toEqual({
      url: 'http://bao.test:8200/v1/auth/approle/login',
      body: JSON.stringify({ role_id: 'role-123', secret_id: 'secret-456' }),
    });
    clock += 2_699_000;
    expect(await provider.token()).toBe('tok-1');
    clock += 2_000;
    expect(await provider.token()).toBe('tok-2');
    provider.invalidate();
    expect(await provider.token()).toBe('tok-3');
  });

  it('shares one login between concurrent callers', async () => {
    const b = bao(60);
    const provider = createVaultTokenProvider(env, b.fetchImpl);
    const tokens = await Promise.all([provider.token(), provider.token(), provider.token()]);
    expect(tokens).toEqual(['tok-1', 'tok-1', 'tok-1']);
    expect(b.calls).toHaveLength(1);
  });

  it('uses a given token without AppRole files, and says so when nothing is configured', async () => {
    const given = createVaultTokenProvider({
      ...env,
      OPENBAO_ROLE_ID_FILE: undefined,
      OPENBAO_TOKEN: 'operator-token',
    });
    expect(given.mode).toBe('token');
    expect(await given.token()).toBe('operator-token');
    const none = createVaultTokenProvider({ ...env, OPENBAO_ROLE_ID_FILE: undefined });
    expect(none.mode).toBe('none');
    await expect(none.token()).rejects.toBeInstanceOf(VaultUnavailableError);
  });

  it('reports a refused login', async () => {
    const refused = createVaultTokenProvider(env, (() =>
      Promise.resolve(
        new Response('{"errors":["invalid role or secret ID"]}', { status: 400 }),
      )) as unknown as typeof fetch);
    await expect(refused.token()).rejects.toThrow('OpenBao refused the AppRole login: HTTP 400');
  });
});
