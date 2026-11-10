// T-565 REQ-INT-009 (ADR-065) — Mutation.sendTestNotification against the compose stack's Postgres, in a tenant of its
// own: an operator's request on a Slack integration writes the test event for the BSM engine and an audit event to the
// outbox in one transaction; an ITSM integration is not a notification sink and is refused; with the tenant's outbound
// switch off nothing is queued.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { TENANT_SETTINGS_DEFAULTS, loadEnv } from '@openmap/config';
import { createPrismaClient } from '@openmap/db';
import { AppModule } from '../app.module.js';
import { JWKS, realmUrl } from '../auth/jwks.provider.js';
import { SIGNING_ALGORITHM } from '../auth/auth.service.js';
import { ROLES } from '../auth/roles.js';

process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
process.env['ANOMALY_INTERVAL_MS'] = '0';
process.env['FEATURE_OUTBOUND_INTEGRATIONS'] = 'true';
const env = loadEnv();
const prisma = createPrismaClient(env);
const TIMEOUT_MS = 120_000;
const KID = 'openmap-notify-key';
const organizationId = randomUUID();
const tenantId = randomUUID();
const MUTATION = 'mutation T($id: UUID!) { sendTestNotification(id: $id) }';
let app: NestFastifyApplication;
let token = '';

async function send(id: string): Promise<{ ok: boolean | null; error: string | null }> {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    payload: { query: MUTATION, variables: { id } },
  });
  const body = JSON.parse(res.body) as {
    data?: { sendTestNotification: boolean } | null;
    errors?: Array<{ message: string }>;
  };
  return { ok: body.data?.sendTestNotification ?? null, error: body.errors?.[0]?.message ?? null };
}

async function integration(name: string, category: 'notification' | 'itsm', vendor: string): Promise<string> {
  const row = await prisma.integrationConfig.create({
    data: {
      tenantId,
      category,
      vendor,
      name,
      enabled: true,
      direction: 'outbound',
      endpoint: 'https://' + vendor + '.lab.test/hook',
      credentialRef: 'openmap/itest/' + vendor,
      settings: {},
      fieldMappings: [],
      classMappings: [],
      subscribedEvents: [],
    },
  });
  return row.id;
}

describe('sendTestNotification (integration)', () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const keys = await generateKeyPair(SIGNING_ALGORITHM);
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: SIGNING_ALGORITHM, use: 'sig' };
    token = await new SignJWT({
      tenant: tenantId,
      preferred_username: 'notify-operator',
      realm_access: { roles: [ROLES.operator] },
      azp: env.KEYCLOAK_CLIENT_ID,
    })
      .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: KID })
      .setIssuer(realmUrl(env).toString())
      .setSubject('notify-' + randomUUID())
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(keys.privateKey);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JWKS)
      .useValue(createLocalJWKSet({ keys: [jwk] }))
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: ['error', 'warn'],
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: 'Notify org',
        industry: 'test',
        timeZone: 'UTC',
        defaultLocale: 'en',
        regulatoryScope: [],
        airGapped: false,
      },
    });
    await prisma.tenant.create({
      data: { id: tenantId, organizationId, name: 'Notify BU', slug: 'ntf-' + tenantId.slice(0, 8) },
    });
    await prisma.tenantSettings.create({
      data: { tenantId, ...TENANT_SETTINGS_DEFAULTS, outboundIntegrationsEnabled: true },
    });
    ids['slack'] = await integration('Ops Slack', 'notification', 'slack');
    ids['snow'] = await integration('ServiceNow', 'itsm', 'servicenow');
  }, TIMEOUT_MS);

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it('queues the test event and its audit entry for a notification integration', async () => {
    expect(await send(id('slack'))).toEqual({ ok: true, error: null });
    const events = await prisma.outboxEvent.findMany({
      where: { tenantId, subject: id('slack') },
      orderBy: { sequence: 'asc' },
    });
    expect(events.map((e) => e.type)).toEqual([
      'openmap.integration.notification.test',
      'openmap.audit.action',
    ]);
    expect((events[0]?.envelope as { data: Record<string, unknown> }).data).toEqual({
      integrationId: id('slack'),
      vendor: 'slack',
      by: 'notify-operator',
    });
    expect(events[0]?.pending).toContain('websocket');
  });

  it('refuses an integration that is not a notification sink, and queues nothing with outbound off', async () => {
    const refused = await send(id('snow'));
    expect(refused.ok).toBeNull();
    expect(refused.error).toMatch(/not a notification integration/u);
    await prisma.tenantSettings.update({ where: { tenantId }, data: { outboundIntegrationsEnabled: false } });
    const closed = await send(id('slack'));
    expect(closed.error).toMatch(/outbound integrations are disabled for this tenant/u);
    expect(
      await prisma.outboxEvent.count({ where: { tenantId, type: 'openmap.integration.notification.test' } }),
    ).toBe(1);
  });

  function id(k: string): string {
    return ids[k] ?? '';
  }
});
