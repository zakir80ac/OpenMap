// T-564 REQ-INT-009 (ADR-065) — notifications against the compose stack's Postgres and OpenBao, in a tenant of its own:
// a webhook integration with its signing secret in OpenBao receives an SLA breach at an in-test HTTP receiver that
// verifies the HMAC signature; an email integration (Arabic) delivers the same event through an in-test SMTP server with
// AUTH; a test event reaches only the integration it names; a disabled integration and one not subscribed get
// nothing; every message is an IntegrationDelivery row in Postgres.
import { createHmac, randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from 'node:net';
import { NOTIFICATION } from '@openmap/constants';
import { loadEnv } from '@openmap/config';
import type { EventEnvelope } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpenBaoReader } from '../service/openbao.js';
import { createNotifier } from './notify.js';

const env = loadEnv();
const prisma = createPrismaClient(env);
const tenantId = randomUUID();
const organizationId = randomUUID();
const SECRET = 'whsec-' + randomUUID();
const refs = {
  webhook: 'openmap/itest/notify-' + tenantId.slice(0, 8) + '/webhook',
  email: 'openmap/itest/notify-' + tenantId.slice(0, 8) + '/email',
};
const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
const mails: string[] = [];
let http: HttpServer;
let smtp: TcpServer;
let httpPort = 0;
let smtpPort = 0;

async function vault(method: 'POST' | 'DELETE', ref: string, data?: Record<string, string>): Promise<void> {
  const path = method === 'POST' ? '/data/' : '/metadata/';
  const res = await fetch(
    new URL(
      'v1/' + env.OPENBAO_MOUNT + path + ref,
      env.OPENBAO_ADDR.endsWith('/') ? env.OPENBAO_ADDR : env.OPENBAO_ADDR + '/',
    ),
    {
      method,
      headers: { 'X-Vault-Token': env.OPENBAO_TOKEN, 'content-type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify({ data }),
    },
  );
  if (!res.ok) throw new Error('OpenBao ' + method + ' ' + String(res.status));
}

function listen(server: HttpServer | TcpServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function integration(
  name: string,
  vendor: string,
  endpoint: string,
  credentialRef: string,
  over: { enabled?: boolean; subscribedEvents?: string[]; settings?: Record<string, unknown> } = {},
): Promise<string> {
  const row = await prisma.integrationConfig.create({
    data: {
      tenantId,
      category: 'notification',
      vendor,
      name,
      enabled: over.enabled ?? true,
      direction: 'outbound',
      endpoint,
      credentialRef,
      settings: (over.settings ?? {}) as object,
      fieldMappings: [],
      classMappings: [],
      subscribedEvents: over.subscribedEvents ?? ['openmap.bsm.sla.breached'],
    },
  });
  return row.id;
}

function event(type: string, data: Record<string, unknown>): EventEnvelope {
  return {
    specversion: '1.0',
    id: randomUUID(),
    source: '/openmap/bsm-engine',
    type: type as EventEnvelope['type'],
    subject: randomUUID(),
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    dataschema: 'x',
    tenantid: tenantId,
    data,
  };
}

describe('notifications (integration)', () => {
  const ids: Record<string, string> = {};
  const notifier = () =>
    createNotifier({
      prisma,
      secrets: createOpenBaoReader(env),
      delivery: { fetchImpl: fetch, sleep: () => Promise.resolve(), now: () => new Date().toISOString() },
      consoleUrl: env.PUBLIC_CONSOLE_URL,
      outboundAllowed: true,
      log: () => undefined,
      now: () => new Date(),
    });

  beforeAll(async () => {
    http = createHttpServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(202, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
    });
    smtp = createTcpServer((socket) => {
      let buffer = '';
      let data = false;
      socket.setEncoding('utf8');
      socket.write('220 itest ESMTP\r\n');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        for (;;) {
          if (data) {
            const end = buffer.indexOf('\r\n.\r\n');
            if (end < 0) return;
            mails.push(buffer.slice(0, end));
            buffer = buffer.slice(end + 5);
            data = false;
            socket.write('250 queued\r\n');
            continue;
          }
          const at = buffer.indexOf('\r\n');
          if (at < 0) return;
          const verb = buffer.slice(0, at).split(' ')[0]?.toUpperCase();
          buffer = buffer.slice(at + 2);
          if (verb === 'EHLO') socket.write('250-itest\r\n250 AUTH PLAIN\r\n');
          else if (verb === 'AUTH') socket.write('235 ok\r\n');
          else if (verb === 'DATA') {
            socket.write('354 go\r\n');
            data = true;
          } else if (verb === 'QUIT') {
            socket.end('221 bye\r\n');
            return;
          } else socket.write('250 ok\r\n');
        }
      });
    });
    httpPort = await listen(http);
    smtpPort = await listen(smtp);
    await vault('POST', refs.webhook, { signingSecret: SECRET });
    await vault('POST', refs.email, { username: 'alerts', password: 'itest-' + randomUUID() });
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
      data: { id: tenantId, organizationId, name: 'notify', slug: 'notify-' + tenantId.slice(0, 8) },
    });
    await prisma.tenantSettings.create({
      data: {
        tenantId,
        locale: 'en',
        timeZone: 'UTC',
        discoveryIntervalMinutes: 60,
        historyRetentionDays: 365,
        staleAfterDays: 7,
        assistantEnabled: true,
        outboundIntegrationsEnabled: true,
      },
    });
    ids['webhook'] = await integration(
      'Ops webhook',
      'webhook',
      'http://127.0.0.1:' + String(httpPort) + '/openmap/events',
      refs.webhook,
    );
    ids['email'] = await integration(
      'NOC email',
      'email_smtp',
      'smtp://127.0.0.1:' + String(smtpPort),
      refs.email,
      { settings: { from: 'openmap@itest.test', to: ['noc@itest.test'], locale: 'ar', startTls: false } },
    );
    ids['disabled'] = await integration(
      'Old webhook',
      'webhook',
      'http://127.0.0.1:' + String(httpPort) + '/old',
      refs.webhook,
      { enabled: false },
    );
    ids['other'] = await integration(
      'Audit webhook',
      'webhook',
      'http://127.0.0.1:' + String(httpPort) + '/audit',
      refs.webhook,
      { subscribedEvents: ['openmap.audit.action'] },
    );
  }, 60_000);

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await vault('DELETE', refs.webhook).catch(() => undefined);
    await vault('DELETE', refs.email).catch(() => undefined);
    await prisma.$disconnect();
    await new Promise<void>((r) =>
      http.close(() => {
        r();
      }),
    );
    await new Promise<void>((r) =>
      smtp.close(() => {
        r();
      }),
    );
  });

  it('signs a webhook and mails the same event in Arabic, recording both deliveries', async () => {
    const e = event('openmap.bsm.sla.breached', { serviceName: 'Card payments', availability: 99.2 });
    const report = await notifier().handle(e);
    expect(report.outcomes.map((o) => [o.integrationId, o.outcome]).sort()).toEqual(
      [
        [ids['email'], 'delivered'],
        [ids['webhook'], 'delivered'],
      ].sort(),
    );
    expect(received).toHaveLength(1);
    const hit = received[0];
    const ts = String(hit?.headers[NOTIFICATION.timestampHeader]);
    expect(hit?.headers[NOTIFICATION.signatureHeader]).toBe(
      'v1=' +
        createHmac('sha256', SECRET)
          .update(ts + '.' + (hit?.body ?? ''))
          .digest('hex'),
    );
    expect(JSON.parse(hit?.body ?? '{}')).toMatchObject({
      id: e.id,
      type: 'openmap.bsm.sla.breached',
      data: { serviceName: 'Card payments' },
    });
    expect(mails).toHaveLength(1);
    expect(mails[0]).toContain(
      'Subject: =?UTF-8?B?' +
        Buffer.from('[حرج] خُرقت اتفاقية مستوى الخدمة: Card payments').toString('base64') +
        '?=',
    );
    const rows = await prisma.integrationDelivery.findMany({
      where: { tenantId, eventId: e.id },
      orderBy: { integrationId: 'asc' },
    });
    expect(rows.map((r) => [r.integrationId, r.state, r.attempts]).sort()).toEqual(
      [
        [ids['email'], 'delivered', 1],
        [ids['webhook'], 'delivered', 1],
      ].sort(),
    );
    expect(rows.find((r) => r.integrationId === ids['webhook'])?.responseCode).toBe(202);
  });

  it('sends a test only to the integration it names, even one not subscribed', async () => {
    received.length = 0;
    const e = event('openmap.integration.notification.test', { integrationId: ids['other'], by: 'itest' });
    const report = await notifier().handle(e);
    expect(report.outcomes).toEqual([
      { integrationId: ids['other'], vendor: 'webhook', outcome: 'delivered' },
    ]);
    expect(received.map((r) => JSON.parse(r.body) as { type: string })).toMatchObject([
      { type: 'openmap.integration.notification.test' },
    ]);
    const disabled = await notifier().handle(
      event('openmap.integration.notification.test', { integrationId: ids['disabled'] }),
    );
    expect(disabled.outcomes).toEqual([]);
  });
});
