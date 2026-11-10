// T-575 REQ-SEC-011 (ADR-067 step 4) — field encryption through Transit: values are sent base64-encoded in one batch,
// nulls and already-encrypted values are left alone, values written before encryption decrypt to themselves, and a
// refused request is an error, never a plaintext fallback.
import { describe, expect, it } from 'vitest';
import { VAULT } from '@openmap/constants';
import { createFieldCipher, isCiphertext, type VaultTokenProvider } from './index.js';

const provider: VaultTokenProvider = { mode: 'token', token: () => Promise.resolve('tok'), invalidate: () => undefined };
const env = { OPENBAO_ADDR: 'http://bao.test:8200' };

/** A Transit stand-in: ciphertext is `vault:v1:` + the base64 plaintext reversed. */
function transit(status = 200) {
  const calls: Array<{ path: string; items: Array<Record<string, string>> }> = [];
  const fetchImpl = ((url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { batch_input: Array<Record<string, string>> };
    calls.push({ path: url.pathname, items: body.batch_input });
    if (status !== 200) return Promise.resolve(new Response('{}', { status }));
    const encrypt = url.pathname.includes('/encrypt/');
    const batch_results = body.batch_input.map((i) =>
      encrypt
        ? { ciphertext: 'vault:v1:' + [...(i['plaintext'] ?? '')].reverse().join('') }
        : { plaintext: [...(i['ciphertext'] ?? '').slice('vault:v1:'.length)].reverse().join('') },
    );
    return Promise.resolve(new Response(JSON.stringify({ data: { batch_results } }), { status: 200 }));
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('field cipher', () => {
  it('encrypts in one batch to the field key, leaving nulls and ciphertext alone, and decrypts back', async () => {
    const t = transit();
    const cipher = createFieldCipher(env, provider, t.fetchImpl);
    const stored = await cipher.encrypt(['Layla Haddad', null, 'layla@vendor.example', 'vault:v1:already']);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.path).toBe('/v1/' + VAULT.transitMount + '/encrypt/' + VAULT.fieldKey);
    expect(t.calls[0]?.items).toEqual([
      { plaintext: Buffer.from('Layla Haddad').toString('base64') },
      { plaintext: Buffer.from('layla@vendor.example').toString('base64') },
    ]);
    expect(stored[1]).toBeNull();
    expect(stored[3]).toBe('vault:v1:already');
    expect(stored.filter((v): v is string => v !== null).every(isCiphertext)).toBe(true);
    expect(await cipher.decrypt(stored.slice(0, 3))).toEqual(['Layla Haddad', null, 'layla@vendor.example']);
  });
  it('returns a value written before encryption as it is, without calling OpenBao', async () => {
    const t = transit();
    const cipher = createFieldCipher(env, provider, t.fetchImpl);
    expect(await cipher.decrypt(['+966 11 000 0000', null])).toEqual(['+966 11 000 0000', null]);
    expect(t.calls).toHaveLength(0);
  });
  it('splits large inputs into Transit batches', async () => {
    const t = transit();
    const cipher = createFieldCipher(env, provider, t.fetchImpl);
    const values = Array.from({ length: VAULT.transitBatch + 1 }, (_, i) => 'v' + String(i));
    const stored = await cipher.encrypt(values);
    expect(t.calls.map((c) => c.items.length)).toEqual([VAULT.transitBatch, 1]);
    expect(await cipher.decrypt(stored)).toEqual(values);
  });
  it('fails when OpenBao refuses, rather than storing plaintext', async () => {
    const cipher = createFieldCipher(env, provider, transit(500).fetchImpl);
    await expect(cipher.encrypt(['x'])).rejects.toThrow(/Transit encrypt: HTTP 500/);
  });
});
