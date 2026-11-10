// REQ-SEC-011 (ADR-068) — the connection options every ClickHouse client of OpenMap uses: one place, so TLS is the same
// everywhere. Over https the server is verified against the internal services CA (SERVICE_CA_PATH); over http, as on an
// install that has not turned TLS on, no TLS options are passed.
import { readFileSync } from 'node:fs';
import type { Env } from '@openmap/config';

export interface ClickHouseOptions {
  url: string;
  username: string;
  password: string;
  database: string;
  tls?: { ca_cert: Buffer };
}

export function clickhouseOptions(
  env: Pick<Env, 'CLICKHOUSE_URL' | 'CLICKHOUSE_USER' | 'CLICKHOUSE_PASSWORD' | 'CLICKHOUSE_DB' | 'SERVICE_CA_PATH'>,
  read: (path: string) => Buffer = (p) => readFileSync(p),
): ClickHouseOptions {
  const base = { url: env.CLICKHOUSE_URL, username: env.CLICKHOUSE_USER, password: env.CLICKHOUSE_PASSWORD, database: env.CLICKHOUSE_DB };
  const secure = new URL(env.CLICKHOUSE_URL).protocol === 'https:';
  return secure && env.SERVICE_CA_PATH !== undefined ? { ...base, tls: { ca_cert: read(env.SERVICE_CA_PATH) } } : base;
}
