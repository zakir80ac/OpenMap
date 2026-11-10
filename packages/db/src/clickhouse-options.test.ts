// T-582 REQ-SEC-011 (ADR-068) — every ClickHouse client takes the same options: over https the server is verified
// against the internal services CA; over http (TLS not turned on) no TLS options are passed.
import { describe, expect, it } from 'vitest';
import { clickhouseOptions } from './clickhouse-options.js';

const env = { CLICKHOUSE_USER: 'u', CLICKHOUSE_PASSWORD: 'p', CLICKHOUSE_DB: 'openmap' };
const read = (path: string): Buffer => Buffer.from('PEM of ' + path);

describe('clickhouseOptions', () => {
  it('adds the CA over https', () => {
    const o = clickhouseOptions({ ...env, CLICKHOUSE_URL: 'https://clickhouse:8443', SERVICE_CA_PATH: '/run/openmap/ca/services-ca.crt' }, read);
    expect(o).toMatchObject({ url: 'https://clickhouse:8443', username: 'u', password: 'p', database: 'openmap' });
    expect(o.tls?.ca_cert.toString()).toBe('PEM of /run/openmap/ca/services-ca.crt');
  });
  it('passes no TLS options over http or without a CA', () => {
    expect(clickhouseOptions({ ...env, CLICKHOUSE_URL: 'http://clickhouse:8123', SERVICE_CA_PATH: '/ca.crt' }, read).tls).toBeUndefined();
    expect(clickhouseOptions({ ...env, CLICKHOUSE_URL: 'https://clickhouse:8443', SERVICE_CA_PATH: undefined }, read).tls).toBeUndefined();
  });
});
