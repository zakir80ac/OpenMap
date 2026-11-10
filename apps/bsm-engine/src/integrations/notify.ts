// REQ-INT-009 (ADR-065) — notifications from the event stream. For each event the notifier finds the tenant's enabled
// notification integrations (webhook, Slack, Teams, email, PagerDuty) subscribed to its type (or the one integration a
// test names), keeps to the deployment's and the tenant's outbound switches, the integration's minimum severity and a
// per-integration rate limit, renders the message in the tenant's (or the integration's) language, sends it and records
// every attempt as an IntegrationDelivery. Webhooks receive the event envelope signed with HMAC-SHA256; Slack, Teams,
// email and PagerDuty receive a worded message linking to the console. Incident events reach PagerDuty through the
// incident adapter instead. Credentials come from OpenBao per message and are never stored or logged.
import { createHmac, randomUUID } from 'node:crypto';
import { DISCOVERY, NOTIFICATION, TIME } from '@openmap/constants';
import {
  INCIDENT_EVENT_PREFIX,
  NOTIFICATION_TEST_EVENT,
  NOTIFICATION_VENDORS,
  emailMessage,
  integrationConfigSchema,
  notificationFacts,
  notificationPath,
  notificationSettingsSchema,
  notificationSeverity,
  pagerDutyPayload,
  severityAtLeast,
  slackPayload,
  teamsPayload,
  type EventEnvelope,
  type IntegrationConfig,
  type IntegrationDelivery,
  type NotificationVendor,
  type RenderedNotification,
} from '@openmap/contracts';
import type { PrismaClient } from '@openmap/db';
import { isLocale, translate, type Locale, type MessageKey } from '@openmap/i18n';
import { deliver, digestOf, type DeliveryDeps } from './delivery.js';
import {
  SmtpError,
  sendMail,
  smtpTargetFrom,
  type MailMessage,
  type SmtpResult,
  type SmtpTarget,
} from './smtp.js';

export interface NotifierSecrets {
  read(ref: string): Promise<{ type: string; fields: Record<string, string> }>;
}

export interface NotifierDeps {
  prisma: PrismaClient;
  secrets: NotifierSecrets;
  delivery: DeliveryDeps;
  /** Sends one email; the SMTP client by default. */
  sendMail?: (target: SmtpTarget, mail: MailMessage) => Promise<SmtpResult>;
  /** Console base URL the messages link to (PUBLIC_CONSOLE_URL). */
  consoleUrl: string;
  /** False in the air-gap profile or with FEATURE_OUTBOUND_INTEGRATIONS off: nothing leaves the deployment. */
  outboundAllowed: boolean;
  log: (line: Record<string, unknown>) => void;
  now: () => Date;
}

export type NotifyOutcome = 'delivered' | 'failed' | 'suppressed' | 'skipped';

export interface NotifyReport {
  delivered: number;
  failed: number;
  suppressed: number;
  skipped: number;
  /** One entry per integration considered, for metrics and tests. */
  outcomes: Array<{ integrationId: string; vendor: NotificationVendor; outcome: NotifyOutcome }>;
}

const OUTBOUND_DIRECTIONS = ['outbound', 'bidirectional'] as const;
const SUBJECT_FIELDS = ['name', 'displayName', 'serviceName', 'title', 'subject'] as const;
const DEFAULT_LOCALE: Locale = 'en';
const RTL_LOCALES: ReadonlySet<Locale> = new Set<Locale>(['ar']);

/** The `x-openmap-signature` value for a body sent at `timestamp` (seconds): v1=<hex HMAC-SHA256 of "<timestamp>.<body>">. */
export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return (
    NOTIFICATION.signatureVersion +
    '=' +
    createHmac('sha256', secret)
      .update(timestamp + '.' + body)
      .digest('hex')
  );
}

function subjectName(event: EventEnvelope): string {
  for (const f of SUBJECT_FIELDS) {
    const v = event.data[f];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return event.subject;
}

/** The message worded in `locale`, linking to the event's screen in the console. */
export function renderNotification(
  event: EventEnvelope,
  locale: Locale,
  consoleUrl: string,
): RenderedNotification {
  const t = (key: string, params?: Record<string, string>): string =>
    translate(locale, key as MessageKey, params);
  const severity = notificationSeverity(event);
  const typeLabel = t('notify.type.' + event.type);
  const isTest = event.type === NOTIFICATION_TEST_EVENT;
  const base = consoleUrl.endsWith('/') ? consoleUrl.slice(0, -1) : consoleUrl;
  return {
    title: isTest ? typeLabel : t('notify.title', { type: typeLabel, subject: subjectName(event) }),
    severity,
    severityLabel: t('notify.severity.' + severity),
    facts: notificationFacts(event.data),
    url: base + '/' + locale + notificationPath(event),
    openLabel: t('notify.open'),
    footer: t('notify.footer', { time: event.time.slice(0, NOTIFICATION.footerTimeLength).replace('T', ' ') + ' UTC' }),
  };
}

export function createNotifier(deps: NotifierDeps) {
  const send = deps.sendMail ?? ((target: SmtpTarget, mail: MailMessage) => sendMail(target, mail));
  const windows = new Map<string, { start: number; count: number }>();

  /** True when the integration may send another message in the current window. */
  const admit = (integrationId: string): boolean => {
    const now = deps.now().getTime();
    const w = windows.get(integrationId);
    if (w === undefined || now - w.start >= NOTIFICATION.windowMs) {
      windows.set(integrationId, { start: now, count: 1 });
      return true;
    }
    if (w.count >= NOTIFICATION.maxPerWindow) return false;
    w.count += 1;
    return true;
  };

  const record = async (d: IntegrationDelivery): Promise<void> => {
    await deps.prisma.integrationDelivery.create({
      data: {
        id: d.id,
        tenantId: d.tenantId,
        integrationId: d.integrationId,
        direction: d.direction,
        eventId: d.eventId,
        remoteId: d.remoteId,
        state: d.state,
        attempts: d.attempts,
        requestDigest: d.requestDigest,
        responseCode: d.responseCode,
        error: d.error,
        createdAt: new Date(d.createdAt),
        completedAt: d.completedAt === null ? null : new Date(d.completedAt),
      },
    });
  };

  /** Email with the same retry schedule as HTTP deliveries; a refusal the server calls permanent (5xx) is not retried. */
  const deliverEmail = async (
    config: IntegrationConfig,
    target: SmtpTarget,
    mail: MailMessage,
    eventId: string,
  ): Promise<IntegrationDelivery> => {
    const nowIso = (): string => deps.delivery.now();
    const delivery: IntegrationDelivery = {
      id: randomUUID(),
      integrationId: config.id,
      tenantId: config.tenantId,
      direction: 'out',
      eventId,
      remoteId: null,
      state: 'pending',
      attempts: 0,
      requestDigest: digestOf({ subject: mail.subject, to: mail.to, text: mail.text }),
      responseCode: null,
      error: null,
      createdAt: nowIso(),
      completedAt: null,
    };
    const maxAttempts = DISCOVERY.retryBackoffMs.length + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      delivery.attempts = attempt + 1;
      try {
        const result = await send(target, mail);
        delivery.state = 'delivered';
        delivery.responseCode = result.code;
        delivery.error = null;
        delivery.completedAt = nowIso();
        return delivery;
      } catch (err) {
        delivery.error = err instanceof Error ? err.message : String(err);
        delivery.responseCode = err instanceof SmtpError ? err.code : null;
        const permanent = delivery.responseCode !== null && delivery.responseCode >= NOTIFICATION.smtpPermanentFrom;
        const backoff = DISCOVERY.retryBackoffMs[attempt];
        if (permanent || backoff === undefined) break;
        delivery.state = 'retrying';
        await deps.delivery.sleep(backoff);
      }
    }
    delivery.state = delivery.attempts >= maxAttempts ? 'dead_letter' : 'failed';
    delivery.completedAt = nowIso();
    return delivery;
  };

  const sendOne = async (
    config: IntegrationConfig,
    vendor: NotificationVendor,
    event: EventEnvelope,
    rendered: RenderedNotification,
    locale: Locale,
  ): Promise<IntegrationDelivery> => {
    const cred = await deps.secrets.read(config.credentialRef);
    const fields = cred.fields;
    const settings = notificationSettingsSchema.parse(config.settings);
    switch (vendor) {
      case 'webhook': {
        const body = event as unknown as Record<string, unknown>;
        const timestamp = String(Math.floor(deps.now().getTime() / TIME.msPerSecond));
        const headers: Record<string, string> = {
          [NOTIFICATION.eventHeader]: event.type,
          [NOTIFICATION.deliveryHeader]: event.id,
          [NOTIFICATION.timestampHeader]: timestamp,
        };
        const secret = fields['signingSecret'];
        if (secret !== undefined && secret !== '')
          headers[NOTIFICATION.signatureHeader] = webhookSignature(secret, timestamp, JSON.stringify(body));
        const token = fields['token'];
        if (token !== undefined && token !== '') headers['authorization'] = 'Bearer ' + token;
        return (
          await deliver({ config, path: '', method: 'POST', headers, body, eventId: event.id }, deps.delivery)
        ).delivery;
      }
      case 'slack':
      case 'microsoft_teams': {
        const target = { ...config, endpoint: fields['url'] ?? config.endpoint };
        const body = vendor === 'slack' ? slackPayload(rendered) : teamsPayload(rendered);
        return (
          await deliver(
            { config: target, path: '', method: 'POST', headers: {}, body, eventId: event.id },
            deps.delivery,
          )
        ).delivery;
      }
      case 'pagerduty': {
        const routingKey = fields['routingKey'] ?? fields['token'] ?? '';
        const body = pagerDutyPayload(rendered, event, routingKey);
        return (
          await deliver(
            {
              config,
              path: NOTIFICATION.pagerDutyEnqueuePath,
              method: 'POST',
              headers: {},
              body,
              eventId: event.id,
            },
            deps.delivery,
          )
        ).delivery;
      }
      case 'email_smtp': {
        const message = emailMessage(rendered, RTL_LOCALES.has(locale) ? 'rtl' : 'ltr');
        const from = settings.from ?? fields['from'] ?? fields['username'] ?? '';
        const target = smtpTargetFrom(config.endpoint, settings.startTls, fields);
        return deliverEmail(
          config,
          target,
          { from, to: settings.to, subject: message.subject, text: message.text, html: message.html },
          event.id,
        );
      }
    }
  };

  async function handle(event: EventEnvelope): Promise<NotifyReport> {
    const report: NotifyReport = { delivered: 0, failed: 0, suppressed: 0, skipped: 0, outcomes: [] };
    if (!deps.outboundAllowed) return report;
    const isTest = event.type === NOTIFICATION_TEST_EVENT;
    const testTarget =
      isTest && typeof event.data['integrationId'] === 'string' ? event.data['integrationId'] : null;
    if (isTest && testTarget === null) return report;
    const rows = await deps.prisma.integrationConfig.findMany({
      where: {
        tenantId: event.tenantid,
        enabled: true,
        vendor: { in: [...NOTIFICATION_VENDORS] },
        direction: { in: [...OUTBOUND_DIRECTIONS] },
        ...(testTarget === null ? { subscribedEvents: { has: event.type } } : { id: testTarget }),
      },
    });
    if (rows.length === 0) return report;
    const tenant = await deps.prisma.tenantSettings.findUnique({ where: { tenantId: event.tenantid } });
    if (tenant !== null && !tenant.outboundIntegrationsEnabled) return report;
    const tenantLocale: Locale = tenant !== null && isLocale(tenant.locale) ? tenant.locale : DEFAULT_LOCALE;
    for (const row of rows) {
      const vendor = row.vendor as NotificationVendor;
      const note = (outcome: NotifyOutcome): void => {
        report[outcome] += 1;
        report.outcomes.push({ integrationId: row.id, vendor, outcome });
      };
      const parsed = integrationConfigSchema.safeParse({
        ...row,
        settings: row.settings ?? {},
        fieldMappings: row.fieldMappings ?? [],
        classMappings: row.classMappings ?? [],
        schedule: row.scheduleCron ? { cron: row.scheduleCron } : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
      const settings = notificationSettingsSchema.safeParse(row.settings ?? {});
      if (!parsed.success || !settings.success) {
        deps.log({ msg: 'notification integration invalid', integrationId: row.id });
        note('skipped');
        continue;
      }
      // Incidents reach PagerDuty through the incident adapter, which also resolves them.
      if (vendor === 'pagerduty' && event.type.startsWith(INCIDENT_EVENT_PREFIX)) {
        note('skipped');
        continue;
      }
      if (!isTest && !severityAtLeast(notificationSeverity(event), settings.data.minSeverity)) {
        note('skipped');
        continue;
      }
      if (!admit(row.id)) {
        note('suppressed');
        continue;
      }
      const locale = settings.data.locale ?? tenantLocale;
      try {
        const delivery = await sendOne(
          parsed.data,
          vendor,
          event,
          renderNotification(event, locale, deps.consoleUrl),
          locale,
        );
        await record(delivery);
        note(delivery.state === 'delivered' ? 'delivered' : 'failed');
      } catch (err) {
        // The message never left (credential unreadable, endpoint unusable): recorded so the console shows why.
        const error = err instanceof Error ? err.message : String(err);
        deps.log({ msg: 'notification not sent', integrationId: row.id, error });
        const at = deps.delivery.now();
        await record({
          id: randomUUID(),
          integrationId: row.id,
          tenantId: event.tenantid,
          direction: 'out',
          eventId: event.id,
          remoteId: null,
          state: 'failed',
          attempts: 0,
          requestDigest: digestOf({ eventId: event.id, vendor }),
          responseCode: null,
          error,
          createdAt: at,
          completedAt: at,
        });
        note('failed');
      }
    }
    return report;
  }

  return { handle };
}

export type Notifier = ReturnType<typeof createNotifier>;
