// T-568 REQ-INT-019 (ADR-066) — backup and restore against the compose stack, on scratch databases so the live stores
// are never touched: a Postgres database and a ClickHouse database are created and migrated, a tenant with three CIs,
// a relationship and a history row is written, the real backup container (`docker compose run backup`) archives both,
// the rows are deleted, the set is verified and restored in place, the rows are back, and reproject rebuilds the
// tenant's graph and search index from the restored Postgres. A tampered archive fails verification.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@clickhouse/client';
import { loadEnv } from '@openmap/config';
import { backupManifestSchema } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { createGraphRepository } from '@openmap/graph';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reprojectTenant } from './reproject.js';
import { createMeilisearchSink } from './worker/dispatcher.js';

const env = loadEnv();
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const composeDir = resolve(repo, 'deploy/compose');
const suffix = randomUUID().slice(0, 8);
const scratch = 'openmap_bk_' + suffix;
const setName = 'itest-' + suffix;
const tenantId = randomUUID();
const organizationId = randomUUID();
const hostUrl = new URL(env.POSTGRES_URL);
hostUrl.pathname = '/' + scratch;
// The same database as the backup container sees it on the compose network, in libpq's spelling of a verified TLS
// connection (ADR-068: POSTGRES_URL is in Prisma's, where sslcert names the CA).
const containerUrl = new URL(hostUrl.toString());
containerUrl.hostname = 'postgres';
containerUrl.port = '5432';
containerUrl.search = '?sslmode=verify-full&sslrootcert=/run/openmap/ca/services-ca.crt';
const admin = createPrismaClient(env);
const db = createPrismaClient({ ...env, POSTGRES_URL: hostUrl.toString() });
const clickhouse = createClient({
  url: env.CLICKHOUSE_URL,
  username: env.CLICKHOUSE_USER,
  password: env.CLICKHOUSE_PASSWORD,
});
const graph = createGraphRepository(env);
const search = createMeilisearchSink(env);

function backup(...args: string[]): { status: number; out: string } {
  const r = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      'docker-compose.yml',
      '-f',
      'docker-compose.apps.yml',
      '--profile',
      'backup',
      'run',
      '--rm',
      '-e',
      'POSTGRES_URL=' + containerUrl.toString(),
      '-e',
      'CLICKHOUSE_DB=' + scratch,
      ...args,
    ],
    { cwd: composeDir, encoding: 'utf8' },
  );
  return { status: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

async function seed(): Promise<void> {
  await db.organization.create({
    data: {
      id: organizationId,
      name: 'Backup org',
      industry: 'test',
      timeZone: 'UTC',
      defaultLocale: 'en',
      regulatoryScope: [],
      airGapped: true,
    },
  });
  await db.tenant.create({ data: { id: tenantId, organizationId, name: 'Backup BU', slug: 'bk-' + suffix } });
  const now = new Date();
  const ids: string[] = [];
  for (const name of ['bk-web-01', 'bk-db-01', 'bk-lb-01']) {
    const id = randomUUID();
    ids.push(id);
    await db.ci.create({
      data: {
        id,
        tenantId,
        type: 'host',
        identity: { fqdn: name + '.test' },
        identityKey: name + '.test',
        name,
        displayName: name,
        code: 'SRV-' + name.toUpperCase(),
        layer: 'hardware',
        lifecycle: 'discovered',
        attributes: {},
        tags: [],
        sourceCollectorId: 'itest',
        sourceNodeId: 'itest',
        sourceRunId: randomUUID(),
        sourceConfidence: 1,
        observedAt: now,
        validFrom: now,
        checksum: 'c'.repeat(64),
      },
    });
  }
  await db.relationship.create({
    data: {
      id: randomUUID(),
      tenantId,
      type: 'depends_on',
      fromCiId: ids[0] ?? '',
      toCiId: ids[1] ?? '',
      attributes: {},
      sourceCollectorId: 'itest',
      sourceNodeId: 'itest',
      sourceRunId: randomUUID(),
      sourceConfidence: 1,
      observedAt: now,
      validFrom: now,
    },
  });
  await clickhouse.command({
    query:
      'INSERT INTO ' +
      scratch +
      '.events (sequence, event_id, tenant_id, type, source, subject, time, traceparent, data, envelope) VALUES (1, {i:UUID}, {t:UUID}, {ty:String}, {so:String}, {s:String}, now64(3), {tp:String}, {d:String}, {d:String})',
    query_params: {
      t: tenantId,
      i: randomUUID(),
      ty: 'openmap.audit.action',
      so: '/openmap/itest',
      s: 'bk',
      tp: '',
      d: '{}',
    },
  });
}

const counts = async (): Promise<{ cis: number; relationships: number; events: number }> => {
  const rows = await (
    await clickhouse.query({
      query: 'SELECT count() AS n FROM ' + scratch + '.events',
      format: 'JSONEachRow',
    })
  ).json<{ n: string }>();
  return {
    cis: await db.ci.count({ where: { tenantId } }),
    relationships: await db.relationship.count({ where: { tenantId } }),
    events: Number(rows[0]?.n ?? 0),
  };
};

describe('backup and restore (integration)', () => {
  beforeAll(async () => {
    await admin.$executeRawUnsafe('CREATE DATABASE ' + scratch);
    execFileSync('node', ['packages/db/dist/cli.js', 'postgres'], {
      cwd: repo,
      env: { ...process.env, POSTGRES_URL: hostUrl.toString() },
      stdio: 'pipe',
    });
    execFileSync('node', ['packages/db/dist/cli.js', 'clickhouse'], {
      cwd: repo,
      env: { ...process.env, CLICKHOUSE_DB: scratch },
      stdio: 'pipe',
    });
    await seed();
  }, 300_000);

  afterAll(async () => {
    backup('--entrypoint', 'rm', 'backup', '-rf', '/backups/' + setName);
    await graph.purgeTenant(tenantId);
    await search.dropTenant(tenantId);
    await db.$disconnect();
    await admin.$executeRawUnsafe('DROP DATABASE IF EXISTS ' + scratch + ' WITH (FORCE)');
    await admin.$disconnect();
    await clickhouse.command({ query: 'DROP DATABASE IF EXISTS ' + scratch + ' SYNC' });
    await clickhouse.close();
    await graph.close();
  }, 300_000);

  it('backs up both stores, restores them after the rows are gone, and rebuilds the graph and search index', async () => {
    expect(await counts()).toEqual({ cis: 3, relationships: 1, events: 1 });
    const created = backup('backup', 'create', setName);
    expect(created.status, created.out).toBe(0);
    const listed = backup('backup', 'list');
    const line = listed.out.split('\n').find((l) => l.includes('"name":"' + setName + '"')) ?? '{}';
    const manifest = backupManifestSchema.parse(JSON.parse(line));
    expect(manifest).toMatchObject({
      status: 'complete',
      postgres: { cis: 3 },
      clickhouse: { database: scratch },
      derived: ['memgraph', 'meilisearch'],
    });
    expect(manifest.postgres?.migration).toMatch(/^\d{4}_/u);
    // REQ-SEC-011 (ADR-067): the backup AppRole took OpenBao's Raft snapshot into the same set.
    expect(manifest.openbao?.bytes).toBeGreaterThan(0);
    // ADR-067 step 5 (T-580): the files are encrypted under a data key Transit wrapped; no plaintext archive is left.
    expect(manifest.encryption).toMatchObject({ cipher: 'aes-256-ctr+hmac-sha256', transitKey: 'openmap-backup' });
    expect(manifest.postgres?.file).toBe('postgres.dump.enc');
    expect(manifest.clickhouse?.archive).toBe('clickhouse.tar.enc');
    // Each name marked, since the output also carries compose's own messages.
    const files = backup('--entrypoint', 'sh', 'backup', '-c', 'ls /backups/' + setName + " | sed 's/^/file:/'");
    const names = files.out.split('\n').filter((l) => l.startsWith('file:')).map((l) => l.slice('file:'.length).trim());
    expect(names.sort()).toEqual(['clickhouse.tar.enc', 'manifest.json', 'openbao.snap', 'postgres.dump.enc']);
    // The archive is not readable as a PostgreSQL archive without the key.
    const raw = backup('--entrypoint', 'sh', 'backup', '-c', 'pg_restore --list /backups/' + setName + '/postgres.dump.enc');
    expect(raw.status).not.toBe(0);

    await db.relationship.deleteMany({ where: { tenantId } });
    await db.ci.deleteMany({ where: { tenantId } });
    await clickhouse.command({ query: 'TRUNCATE TABLE ' + scratch + '.events' });
    expect(await counts()).toEqual({ cis: 0, relationships: 0, events: 0 });

    const restored = backup('backup', 'restore', setName);
    expect(restored.status, restored.out).toBe(0);
    expect(restored.out).toContain('backup verified');
    expect(await counts()).toEqual({ cis: 3, relationships: 1, events: 1 });

    const report = await reprojectTenant({ prisma: db, graph, search }, tenantId, false);
    expect(report).toMatchObject({ tenantId, cis: 3, relationships: 1 });
    const layers = await graph.layerCounts(tenantId, null);
    expect(layers.find((l) => l.layer === 'hardware')?.count).toBe(3);
  });

  it('refuses a set whose archive was changed after it was written', () => {
    // A changed byte with the checksum updated to match is still caught: the MAC needs the key.
    const tampered = backup(
      '--entrypoint',
      'sh',
      'backup',
      '-c',
      `f=/backups/${setName}/postgres.dump.enc; m=/backups/${setName}/manifest.json; printf x >> "$f"; ` +
        `old=$(grep -o '"postgres":{[^}]*' "$m" | grep -o '"sha256":"[a-f0-9]*"' | cut -d'"' -f4); ` +
        `new=$(sha256sum "$f" | cut -d' ' -f1); sed -i "s/$old/$new/" "$m"`,
    );
    expect(tampered.status, tampered.out).toBe(0);
    const verified = backup('backup', 'verify', setName);
    expect(verified.status).not.toBe(0);
    expect(verified.out).toContain('postgres archive fails authentication');
  });
});
