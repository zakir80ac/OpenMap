// T-581 REQ-SEC-011 (ADR-068) — the migration runner's node-postgres client takes the TLS intent of a Prisma-style
// POSTGRES_URL: the CA from `sslcert`, the server verified unless `sslaccept=accept_invalid_certs`, and no TLS
// parameters left in the connection string (node-postgres would read `sslcert` as a client certificate).
import { describe, expect, it } from 'vitest';
import { pgClientConfig } from './pg-config.js';

const read = (path: string): string => 'PEM of ' + path;

describe('pgClientConfig', () => {
  it('verifies the server against the CA a Prisma-style URL names', () => {
    const config = pgClientConfig('postgresql://u:p@postgres:5432/openmap?sslmode=require&sslcert=/run/openmap/ca/services-ca.crt&sslaccept=strict', read);
    expect(config.connectionString).toBe('postgresql://u:p@postgres:5432/openmap');
    expect(config.ssl).toEqual({ rejectUnauthorized: true, ca: 'PEM of /run/openmap/ca/services-ca.crt' });
  });
  it('keeps other parameters and takes libpq spelling too', () => {
    const config = pgClientConfig('postgresql://u:p@localhost:5432/openmap?connect_timeout=30&sslmode=verify-full&sslrootcert=/ca.crt', read);
    expect(config.connectionString).toBe('postgresql://u:p@localhost:5432/openmap?connect_timeout=30');
    expect(config.ssl).toEqual({ rejectUnauthorized: true, ca: 'PEM of /ca.crt' });
  });
  it('encrypts without verification only when asked, and stays plaintext without sslmode', () => {
    expect(pgClientConfig('postgresql://u:p@h/db?sslmode=require&sslaccept=accept_invalid_certs', read).ssl).toEqual({ rejectUnauthorized: false });
    expect(pgClientConfig('postgresql://u:p@h/db', read)).toEqual({ connectionString: 'postgresql://u:p@h/db' });
    expect(pgClientConfig('postgresql://u:p@h/db?sslmode=disable', read).ssl).toBeUndefined();
  });
});
