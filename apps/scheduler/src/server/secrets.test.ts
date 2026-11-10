// T-022 REQ-SEC-002
import { describe, expect, it } from 'vitest';
import { createOpenBaoReader } from './secrets.js';

describe('openbao reader', () => {
  const env = {
    OPENBAO_ADDR: 'http://bao.test:8200',
    OPENBAO_TOKEN: 't',
    OPENBAO_ROLE_ID_FILE: undefined,
    OPENBAO_SECRET_ID_FILE: undefined,
    OPENBAO_APPROLE_MOUNT: 'approle',
    OPENBAO_MOUNT: 'openmap',
  };
  it('reads KV v2 data and separates the type from the fields', async () => {
    let seen = '';
    const fetchImpl: typeof fetch = async (url, init) => {
      seen = String(url) + '|' + String((init?.headers as Record<string, string>)['X-Vault-Token']);
      return new Response(
        JSON.stringify({
          data: {
            data: { type: 'snmp_v3', username: 'om', authProtocol: 'SHA256' },
            metadata: { version: 3 },
          },
        }),
        { status: 200 },
      );
    };
    const cred = await createOpenBaoReader(env, fetchImpl).read('creds/snmp-prod');
    expect(cred.type).toBe('snmp_v3');
    expect(cred.fields).toEqual({ username: 'om', authProtocol: 'SHA256' });
    expect(seen).toBe('http://bao.test:8200/v1/openmap/data/creds/snmp-prod|t');
  });
  it('rejects odd references and missing types', async () => {
    const reader = createOpenBaoReader(
      env,
      async () => new Response(JSON.stringify({ data: { data: { username: 'x' }, metadata: {} } })),
    );
    await expect(reader.read('../etc')).rejects.toThrow();
    await expect(reader.read('creds/x')).rejects.toThrow(/type/);
  });
});
