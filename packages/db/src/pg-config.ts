// REQ-SEC-011 (ADR-068) — POSTGRES_URL is written in Prisma's spelling (`sslmode=require&sslcert=<CA>&sslaccept=strict`),
// where `sslcert` names the CA that signed the server certificate. node-postgres reads `sslcert` as a client
// certificate, so the runner's client gets the same intent translated: the CA from that file, the server certificate
// verified unless `sslaccept=accept_invalid_certs`, and the TLS parameters taken out of the connection string.
import { readFileSync } from 'node:fs';
import type { ClientConfig } from 'pg';

const TLS_PARAMS = ['sslmode', 'sslcert', 'sslaccept', 'sslrootcert', 'sslidentity', 'sslpassword'] as const;
const PLAINTEXT_MODES = new Set(['disable', 'allow', 'prefer']);

export function pgClientConfig(url: string, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): ClientConfig {
  const parsed = new URL(url);
  const mode = parsed.searchParams.get('sslmode');
  const ca = parsed.searchParams.get('sslcert') ?? parsed.searchParams.get('sslrootcert');
  const accept = parsed.searchParams.get('sslaccept');
  for (const p of TLS_PARAMS) parsed.searchParams.delete(p);
  const connectionString = parsed.toString();
  if (mode === null || PLAINTEXT_MODES.has(mode)) return { connectionString };
  return {
    connectionString,
    ssl: {
      rejectUnauthorized: accept !== 'accept_invalid_certs',
      ...(ca === null ? {} : { ca: read(ca) }),
    },
  };
}
