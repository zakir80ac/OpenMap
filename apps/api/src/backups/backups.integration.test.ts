// T-569 REQ-INT-019 (ADR-066) — Query.backups against the compose stack's API module, over a backup directory holding a
// complete set, a failed one, one still running and a directory that is not a set: newest first, the newest complete
// set named, stale after the window; administrators only; Prometheus reads the newest completion time at scrape time.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { loadEnv } from '@openmap/config';
import { AppModule } from '../app.module.js';
import { JWKS, realmUrl } from '../auth/jwks.provider.js';
import { SIGNING_ALGORITHM } from '../auth/auth.service.js';
import { ROLES } from '../auth/roles.js';
import { BACKUP_FRESHNESS_METRIC } from './backups.service.js';

const dir = mkdtempSync(join(tmpdir(), 'openmap-backups-'));
process.env['BACKUP_DIR'] = dir;
process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
process.env['ANOMALY_INTERVAL_MS'] = '0';
const env = loadEnv();
const KID = 'openmap-backup-key';
const QUERY =
  '{ backups { configured stale staleAfterHours lastCompleteAt sets { name status createdAt completedAt postgresBytes clickhouseBytes migration cis encrypted error } } }';
let app: NestFastifyApplication;
let privateKey: KeyLike;
const sha = 'b'.repeat(64);
const complete = new Date(Date.now() - 2 * 3_600_000).toISOString();

function set(name: string, body: Record<string, unknown> | string): void {
  mkdirSync(join(dir, name));
  writeFileSync(join(dir, name, 'manifest.json'), typeof body === 'string' ? body : JSON.stringify(body));
}

async function token(role: string): Promise<string> {
  return new SignJWT({
    tenant: randomUUID(),
    preferred_username: 'backup-' + role,
    realm_access: { roles: [role] },
    azp: env.KEYCLOAK_CLIENT_ID,
  })
    .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: KID })
    .setIssuer(realmUrl(env).toString())
    .setSubject('backup-' + randomUUID())
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

async function query(
  role: string,
): Promise<{ data: { backups: Record<string, unknown> } | null; errors?: Array<{ message: string }> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (await token(role)) },
    payload: { query: QUERY },
  });
  return JSON.parse(res.body) as {
    data: { backups: Record<string, unknown> } | null;
    errors?: Array<{ message: string }>;
  };
}

describe('backups (integration)', () => {
  beforeAll(async () => {
    const base = { format: 'openmap-backup/1', derived: ['memgraph', 'meilisearch'] };
    set('openmap-20261110T060000Z', {
      ...base,
      name: 'openmap-20261110T060000Z',
      status: 'complete',
      createdAt: complete,
      completedAt: complete,
      postgres: {
        file: 'postgres.dump',
        bytes: 2_000_000,
        sha256: sha,
        migration: '0043_firewall_object_ci_type',
        cis: 32_765,
      },
      clickhouse: { directory: 'clickhouse', archive: 'clickhouse.tar.enc', database: 'openmap', bytes: 900_000, files: 120, sha256: sha },
      // REQ-SEC-011 (ADR-067 step 5): an encrypted set names its wrapped data key.
      encryption: { cipher: 'aes-256-ctr+hmac-sha256', transitKey: 'openmap-backup', key: 'vault:v1:wrapped' },
      error: null,
    });
    set('openmap-20261110T070000Z', {
      ...base,
      name: 'openmap-20261110T070000Z',
      status: 'failed',
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      completedAt: new Date(Date.now() - 3_500_000).toISOString(),
      postgres: null,
      clickhouse: null,
      error: 'interrupted or failed; see the backup log',
    });
    set('openmap-20261110T080000Z', {
      ...base,
      name: 'openmap-20261110T080000Z',
      status: 'running',
      createdAt: new Date().toISOString(),
      completedAt: null,
      postgres: null,
      clickhouse: null,
      error: null,
    });
    set('lost+found', 'not json');
    const keys = await generateKeyPair(SIGNING_ALGORITHM);
    privateKey = keys.privateKey;
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: SIGNING_ALGORITHM, use: 'sig' };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JWKS)
      .useValue(createLocalJWKSet({ keys: [jwk] }))
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: ['error', 'warn'],
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 120_000);

  afterAll(async () => {
    if (app !== undefined) await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists the sets newest first with the newest complete one, and is fresh within the window', async () => {
    const body = await query(ROLES.admin);
    expect(body.errors).toBeUndefined();
    const b = body.data?.backups as {
      configured: boolean;
      stale: boolean;
      staleAfterHours: number;
      lastCompleteAt: string;
      sets: Array<Record<string, unknown>>;
    };
    expect(b.configured).toBe(true);
    expect(b.stale).toBe(false);
    expect(b.staleAfterHours).toBe(26);
    expect(b.lastCompleteAt).toBe(complete);
    expect(b.sets.map((s) => [s['name'], s['status']])).toEqual([
      ['openmap-20261110T080000Z', 'running'],
      ['openmap-20261110T070000Z', 'failed'],
      ['openmap-20261110T060000Z', 'complete'],
    ]);
    expect(b.sets[2]).toMatchObject({
      postgresBytes: 2_000_000,
      clickhouseBytes: 900_000,
      migration: '0043_firewall_object_ci_type',
      cis: 32_765,
      encrypted: true,
    });
    expect(b.sets[1]).toMatchObject({ encrypted: false });
    expect(b.sets[1]?.['error']).toBe('interrupted or failed; see the backup log');
  });

  it('is for administrators only, and Prometheus reads the newest completion time', async () => {
    const refused = await query(ROLES.analyst);
    expect(refused.errors?.[0]?.message).toMatch(/forbidden|role/iu);
    const res = await app.inject({ method: 'GET', url: env.METRICS_PATH });
    const line = res.body.split('\n').find((l) => l.startsWith(BACKUP_FRESHNESS_METRIC + ' '));
    expect(Number(line?.split(' ')[1])).toBe(Date.parse(complete) / 1000);
  });
});
