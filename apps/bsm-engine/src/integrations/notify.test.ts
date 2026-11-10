// T-563 REQ-INT-009 (ADR-065) — the notifier over in-test doubles of Prisma, the HTTP client, OpenBao and SMTP:
// a webhook receives the event envelope with a verifiable HMAC signature; Slack and Teams receive worded messages at the
// address in the credential; email goes to the configured recipients in Arabic, right to left; PagerDuty skips incident
// events (the incident adapter sends those); severity below the integration's minimum, a closed tenant or deployment
// switch, and a burst above the rate limit send nothing; a test event reaches exactly the named integration; a credential
// OpenBao cannot give is recorded as a failed delivery.
import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NOTIFICATION } from '@openmap/constants';
import { EVENT_TYPES, type EventEnvelope } from '@openmap/contracts';
import type { PrismaClient } from '@openmap/db';
import { LOCALES, translate, type MessageKey } from '@openmap/i18n';
import { createNotifier, renderNotification, webhookSignature, type NotifierDeps } from './notify.js';
import type { MailMessage, SmtpTarget } from './smtp.js';

const tenantId = randomUUID();
type Row = {
  id: string;
  vendor: string;
  subscribedEvents: string[];
  settings: Record<string, unknown>;
  endpoint: string;
  credentialRef: string;
  enabled: boolean;
  direction: string;
};

function row(vendor: string, over: Partial<Row> = {}): Row {
  return {
    id: randomUUID(),
    vendor,
    subscribedEvents: ['openmap.bsm.sla.breached', 'openmap.incident.opened'],
    settings: {},
    endpoint: 'https://' + vendor + '.lab.test/hook',
    credentialRef: 'openmap/notify/' + vendor,
    enabled: true,
    direction: 'outbound',
    ...over,
  };
}

function event(type: string, data: Record<string, unknown> = {}): EventEnvelope {
  return {
    specversion: '1.0',
    id: randomUUID(),
    source: '/openmap/bsm-engine',
    type: type as EventEnvelope['type'],
    subject: 'svc-1',
    time: '2026-11-10T12:00:00.000Z',
    datacontenttype: 'application/json',
    dataschema: 'x',
    tenantid: tenantId,
    data,
  };
}

interface Harness {
  deps: NotifierDeps;
  requests: Array<{ url: string; headers: Record<string, string>; body: string }>;
  mails: Array<{ target: SmtpTarget; mail: MailMessage }>;
  deliveries: Array<Record<string, unknown>>;
}

function harness(
  rows: Row[],
  opts: { locale?: string; outbound?: boolean; tenantOutbound?: boolean; secretsFail?: string } = {},
): Harness {
  const requests: Harness['requests'] = [];
  const mails: Harness['mails'] = [];
  const deliveries: Harness['deliveries'] = [];
  const now = new Date('2026-11-10T12:00:00.000Z');
  const prisma = {
    integrationConfig: {
      findMany: ({
        where,
      }: {
        where: { vendor: { in: string[] }; subscribedEvents?: { has: string }; id?: string };
      }) =>
        Promise.resolve(
          rows
            .filter(
              (r) =>
                where.vendor.in.includes(r.vendor) &&
                r.enabled &&
                (where.id === undefined
                  ? r.subscribedEvents.includes(where.subscribedEvents?.has ?? '')
                  : r.id === where.id),
            )
            .map((r) => ({
              ...r,
              tenantId,
              category: 'notification',
              name: r.vendor,
              fieldMappings: [],
              classMappings: [],
              scheduleCron: null,
              createdAt: now,
              updatedAt: now,
            })),
        ),
    },
    tenantSettings: {
      findUnique: () =>
        Promise.resolve({
          tenantId,
          locale: opts.locale ?? 'en',
          outboundIntegrationsEnabled: opts.tenantOutbound ?? true,
        }),
    },
    integrationDelivery: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        deliveries.push(data);
        return Promise.resolve(data);
      },
    },
  } as unknown as PrismaClient;
  const fields: Record<string, Record<string, string>> = {
    'openmap/notify/webhook': { signingSecret: 'shh', token: 'tkn' },
    'openmap/notify/slack': { url: 'https://hooks.slack.test/services/T/B/X' },
    'openmap/notify/microsoft_teams': { url: 'https://teams.lab.test/webhook/abc' },
    'openmap/notify/email_smtp': { username: 'alerts', password: 'pw' },
    'openmap/notify/pagerduty': { routingKey: 'R0UTE' },
  };
  return {
    requests,
    mails,
    deliveries,
    deps: {
      prisma,
      secrets: {
        read: (ref) =>
          ref === opts.secretsFail
            ? Promise.reject(new Error('OpenBao returned 403 for ' + ref))
            : Promise.resolve({ type: 'token', fields: fields[ref] ?? {} }),
      },
      delivery: {
        fetchImpl: ((url: string, init: RequestInit) => {
          requests.push({
            url: String(url),
            headers: init.headers as Record<string, string>,
            body: String(init.body),
          });
          return Promise.resolve(new Response('{}', { status: 200 }));
        }) as typeof fetch,
        sleep: () => Promise.resolve(),
        now: () => now.toISOString(),
      },
      sendMail: (target, mail) => {
        mails.push({ target, mail });
        return Promise.resolve({ code: 250, response: 'queued' });
      },
      consoleUrl: 'https://openmap.lab.test/',
      outboundAllowed: opts.outbound ?? true,
      log: () => undefined,
      now: () => now,
    },
  };
}

describe('notifier', () => {
  it('signs webhooks and words Slack, Teams, email and PagerDuty messages', async () => {
    const rows = [
      row('webhook'),
      row('slack'),
      row('microsoft_teams'),
      row('email_smtp', {
        endpoint: 'smtp://mail.lab.test:2525',
        settings: { from: 'openmap@lab.test', to: ['noc@lab.test'] },
      }),
      row('pagerduty', { endpoint: 'https://events.pd.test/' }),
    ];
    const h = harness(rows);
    const e = event('openmap.bsm.sla.breached', { serviceName: 'Card payments', availability: 99.2 });
    const report = await createNotifier(h.deps).handle(e);
    expect(report.delivered).toBe(5);
    expect(h.deliveries.map((d) => d['state'])).toEqual([
      'delivered',
      'delivered',
      'delivered',
      'delivered',
      'delivered',
    ]);
    const hook = h.requests.find((r) => r.url === 'https://webhook.lab.test/hook');
    expect(JSON.parse(hook?.body ?? '{}')).toEqual(e);
    const ts = hook?.headers[NOTIFICATION.timestampHeader] ?? '';
    expect(hook?.headers[NOTIFICATION.signatureHeader]).toBe(
      'v1=' +
        createHmac('sha256', 'shh')
          .update(ts + '.' + (hook?.body ?? ''))
          .digest('hex'),
    );
    expect(hook?.headers['authorization']).toBe('Bearer tkn');
    expect(hook?.headers[NOTIFICATION.eventHeader]).toBe('openmap.bsm.sla.breached');
    const slack = h.requests.find((r) => r.url === 'https://hooks.slack.test/services/T/B/X');
    expect(JSON.parse(slack?.body ?? '{}')).toMatchObject({ text: 'Critical: SLA breached: Card payments' });
    expect(
      h.requests.some(
        (r) => r.url === 'https://teams.lab.test/webhook/abc' && r.body.includes('AdaptiveCard'),
      ),
    ).toBe(true);
    expect(h.requests.find((r) => r.url === 'https://events.pd.test/v2/enqueue')?.body).toContain(
      '"routing_key":"R0UTE"',
    );
    expect(h.mails[0]?.target).toMatchObject({ host: 'mail.lab.test', port: 2525, username: 'alerts' });
    expect(h.mails[0]?.mail).toMatchObject({
      from: 'openmap@lab.test',
      to: ['noc@lab.test'],
      subject: '[Critical] SLA breached: Card payments',
    });
    expect(h.mails[0]?.mail.text).toContain('https://openmap.lab.test/en/services');
  });

  it('writes Arabic right to left, and leaves incidents on PagerDuty to the incident adapter', async () => {
    const h = harness(
      [
        row('email_smtp', {
          endpoint: 'smtp://mail.lab.test',
          settings: { from: 'o@lab.test', to: ['n@lab.test'] },
        }),
        row('pagerduty'),
      ],
      { locale: 'ar' },
    );
    const report = await createNotifier(h.deps).handle(
      event('openmap.incident.opened', { severity: 'high', title: 'Ledger down' }),
    );
    expect(report.outcomes.map((o) => [o.vendor, o.outcome])).toEqual([
      ['email_smtp', 'delivered'],
      ['pagerduty', 'skipped'],
    ]);
    expect(h.mails[0]?.mail.subject).toBe('[حرج] فُتح حادث: Ledger down');
    expect(h.mails[0]?.mail.html).toContain('<html dir="rtl">');
    expect(h.mails[0]?.mail.text).toContain('https://openmap.lab.test/ar/services');
  });

  it('sends nothing below the minimum severity, when outbound is off, or past the rate limit', async () => {
    const quiet = harness([
      row('slack', { settings: { minSeverity: 'critical' }, subscribedEvents: ['openmap.bsm.sla.at_risk'] }),
    ]);
    expect((await createNotifier(quiet.deps).handle(event('openmap.bsm.sla.at_risk'))).skipped).toBe(1);
    expect(quiet.requests).toEqual([]);
    const airgap = harness([row('slack')], { outbound: false });
    expect((await createNotifier(airgap.deps).handle(event('openmap.bsm.sla.breached'))).outcomes).toEqual(
      [],
    );
    const closed = harness([row('slack')], { tenantOutbound: false });
    expect((await createNotifier(closed.deps).handle(event('openmap.bsm.sla.breached'))).outcomes).toEqual(
      [],
    );
    const burst = harness([row('webhook')]);
    const notifier = createNotifier(burst.deps);
    let suppressed = 0;
    for (let i = 0; i < NOTIFICATION.maxPerWindow + 5; i++)
      suppressed += (await notifier.handle(event('openmap.bsm.sla.breached'))).suppressed;
    expect(burst.requests).toHaveLength(NOTIFICATION.maxPerWindow);
    expect(suppressed).toBe(5);
  });

  it('sends a test to exactly the named integration, and records a credential it could not read', async () => {
    const target = row('slack', { subscribedEvents: [] });
    const other = row('microsoft_teams', { subscribedEvents: [] });
    const h = harness([target, other], { secretsFail: 'openmap/notify/microsoft_teams' });
    const report = await createNotifier(h.deps).handle(
      event('openmap.integration.notification.test', { integrationId: target.id, by: 'ops' }),
    );
    expect(report.outcomes).toEqual([{ integrationId: target.id, vendor: 'slack', outcome: 'delivered' }]);
    expect(JSON.parse(h.requests[0]?.body ?? '{}')).toMatchObject({
      text: 'Information: Test notification from OpenMap',
    });
    const failing = await createNotifier(h.deps).handle(
      event('openmap.integration.notification.test', { integrationId: other.id }),
    );
    expect(failing.failed).toBe(1);
    expect(h.deliveries.at(-1)).toMatchObject({
      integrationId: other.id,
      state: 'failed',
      attempts: 0,
      error: 'OpenBao returned 403 for openmap/notify/microsoft_teams',
    });
  });

  it('labels every event type in both languages and signs the documented string', () => {
    const e = event('openmap.ci.updated', { name: 'web-01' });
    expect(renderNotification(e, 'en', 'https://o.test').title).toBe('Configuration item changed: web-01');
    expect(renderNotification(e, 'ar', 'https://o.test').url).toBe('https://o.test/ar/cmdb/svc-1');
    expect(webhookSignature('k', '1', '{}')).toBe(
      'v1=' + createHmac('sha256', 'k').update('1.{}').digest('hex'),
    );
    for (const type of EVENT_TYPES) {
      for (const locale of LOCALES)
        expect(translate(locale, ('notify.type.' + type) as MessageKey), locale + ' ' + type).not.toBe(
          'notify.type.' + type,
        );
    }
  });
});
