// REQ-INT-009 (ADR-065) — notifications shared by the BSM engine, the API, the console and the tests: which vendors
// are notification sinks, how severe an event is, the facts and console link a message carries, the settings a
// notification integration takes, and each sink's payload (Slack Block Kit, a Teams Adaptive Card, an email, a
// PagerDuty Events v2 trigger; a webhook receives the event envelope itself). Pure and browser-safe: the engine
// translates the texts and signs webhooks.
import { NOTIFICATION } from '@openmap/constants';
import { z } from 'zod';
import type { EventEnvelope, EventType } from './event.js';

export const NOTIFICATION_VENDORS = [
  'webhook',
  'slack',
  'microsoft_teams',
  'email_smtp',
  'pagerduty',
] as const;
export type NotificationVendor = (typeof NOTIFICATION_VENDORS)[number];

export function isNotificationVendor(vendor: string): vendor is NotificationVendor {
  return (NOTIFICATION_VENDORS as readonly string[]).includes(vendor);
}

export const NOTIFICATION_TEST_EVENT = 'openmap.integration.notification.test' satisfies EventType;

/** Incident events reach PagerDuty through the incident adapter (with its dedup and resolve); the notifier skips them. */
export const INCIDENT_EVENT_PREFIX = 'openmap.incident.';

export const NOTIFICATION_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/** Settings a notification integration takes (unknown keys belong to other adapters and are ignored). */
export const notificationSettingsSchema = z.object({
  /** Events below this severity are not sent. */
  minSeverity: z.enum(NOTIFICATION_SEVERITIES).default('info'),
  /** Language of the message; the tenant's locale when unset. */
  locale: z.enum(['en', 'ar']).optional(),
  /** Email: sender and recipients. */
  from: z.email().optional(),
  to: z.array(z.email()).default([]),
  /** Email over smtp://: upgrade with STARTTLS (smtps:// is TLS from the first byte). */
  startTls: z.boolean().default(true),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

const SEVERITY_RANK: Readonly<Record<NotificationSeverity, number>> = { info: 0, warning: 1, critical: 2 };

export function severityAtLeast(severity: NotificationSeverity, minimum: NotificationSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minimum];
}

const CRITICAL_WORDS: ReadonlySet<string> = new Set(['critical', 'high', 'down', 'expired', 'breached']);
const WARNING_WORDS: ReadonlySet<string> = new Set(['medium', 'warning', 'degraded', 'at_risk', 'low']);
const SEVERITY_FIELDS = ['severity', 'state', 'health', 'status'] as const;

const TYPE_SEVERITY: Partial<Record<EventType, NotificationSeverity>> = {
  'openmap.bsm.sla.breached': 'critical',
  'openmap.security.alert.received': 'critical',
  'openmap.bsm.sla.at_risk': 'warning',
  'openmap.integration.delivery.failed': 'warning',
  'openmap.integration.credential.expiring': 'warning',
  'openmap.vulnerability.correlated': 'warning',
  'openmap.dcim.power.threshold': 'warning',
  'openmap.ipam.address.conflict': 'warning',
  'openmap.ipam.subnet.utilisation': 'warning',
  'openmap.asset.stock.low': 'warning',
  'openmap.asset.warranty.expiring': 'warning',
  'openmap.asset.eos.approaching': 'warning',
  'openmap.discovery.job.failed': 'warning',
  'openmap.reconciliation.conflict': 'warning',
  'openmap.certificate.expiring': 'warning',
  'openmap.assistant.query.failed': 'warning',
};

/** How severe an event is: from its own severity, state or health when it carries one, else from its type. */
export function notificationSeverity(event: Pick<EventEnvelope, 'type' | 'data'>): NotificationSeverity {
  for (const field of SEVERITY_FIELDS) {
    const v = event.data[field];
    if (typeof v !== 'string') continue;
    const word = v.toLowerCase();
    if (CRITICAL_WORDS.has(word)) return 'critical';
    if (WARNING_WORDS.has(word)) return 'warning';
  }
  if (
    event.type === 'openmap.certificate.expiring' &&
    (event.data['expired'] === true || event.data['thresholdDays'] === 0)
  )
    return 'critical';
  return TYPE_SEVERITY[event.type] ?? 'info';
}

/** The data fields a message shows: scalars (and short scalar lists), at most NOTIFICATION.maxFacts, values capped. */
export function notificationFacts(data: Readonly<Record<string, unknown>>): Array<[string, string]> {
  const facts: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(data)) {
    if (facts.length >= NOTIFICATION.maxFacts) break;
    let text: string | null = null;
    if (typeof value === 'string' && value.trim() !== '') text = value;
    else if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
    else if (typeof value === 'boolean') text = String(value);
    else if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((v) => typeof v === 'string' || typeof v === 'number')
    )
      text = value.join(', ');
    if (text === null) continue;
    facts.push([
      key,
      text.length > NOTIFICATION.factMaxLength ? text.slice(0, NOTIFICATION.factMaxLength - 1) + '…' : text,
    ]);
  }
  return facts;
}

const PATHS: ReadonlyArray<readonly [string, (subject: string) => string]> = [
  ['openmap.ci.', (s) => '/cmdb/' + encodeURIComponent(s)],
  ['openmap.component.', (s) => '/cmdb/' + encodeURIComponent(s)],
  ['openmap.certificate.', () => '/certificates'],
  ['openmap.bsm.', () => '/services'],
  ['openmap.incident.', () => '/services'],
  ['openmap.integration.', () => '/integrations'],
  ['openmap.discovery.', () => '/discovery'],
  ['openmap.reconciliation.', () => '/discovery'],
  ['openmap.asset.', () => '/assets'],
  ['openmap.plan.', () => '/assets'],
  ['openmap.vulnerability.', () => '/vulnerabilities'],
  ['openmap.security.', () => '/vulnerabilities'],
  ['openmap.ipam.', () => '/ipam'],
  ['openmap.dcim.', () => '/dcim'],
  ['openmap.impact.', () => '/impact'],
  ['openmap.dependency.', () => '/dependencies'],
];

/** The console path (without locale) where the event's subject is seen. */
export function notificationPath(event: Pick<EventEnvelope, 'type' | 'subject'>): string {
  for (const [prefix, path] of PATHS) if (event.type.startsWith(prefix)) return path(event.subject);
  return '/dashboard';
}

/** A message already worded in the recipient's language. */
export interface RenderedNotification {
  title: string;
  severity: NotificationSeverity;
  severityLabel: string;
  facts: Array<[string, string]>;
  url: string;
  openLabel: string;
  footer: string;
}

/** Slack incoming-webhook message (Block Kit). */
export function slackPayload(r: RenderedNotification): Record<string, unknown> {
  const blocks: Array<Record<string, unknown>> = [
    { type: 'header', text: { type: 'plain_text', text: r.title, emoji: false } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: '*' + r.severityLabel + '* · ' + r.footer }] },
  ];
  if (r.facts.length > 0)
    blocks.push({
      type: 'section',
      fields: r.facts.map(([k, v]) => ({ type: 'mrkdwn', text: '*' + k + '*\n' + v })),
    });
  blocks.push({
    type: 'actions',
    elements: [{ type: 'button', text: { type: 'plain_text', text: r.openLabel }, url: r.url }],
  });
  return { text: r.severityLabel + ': ' + r.title, blocks };
}

const TEAMS_COLOUR: Readonly<Record<NotificationSeverity, string>> = {
  info: 'Default',
  warning: 'Warning',
  critical: 'Attention',
};

/** Microsoft Teams incoming-webhook (or Workflows) message carrying an Adaptive Card. */
export function teamsPayload(r: RenderedNotification): Record<string, unknown> {
  return {
    type: 'message',
    attachments: [
      {
        contentType: NOTIFICATION.adaptiveCardContentType,
        contentUrl: null,
        content: {
          type: 'AdaptiveCard',
          version: NOTIFICATION.adaptiveCardVersion,
          body: [
            {
              type: 'TextBlock',
              text: r.title,
              weight: 'Bolder',
              size: 'Medium',
              wrap: true,
              color: TEAMS_COLOUR[r.severity],
            },
            {
              type: 'TextBlock',
              text: r.severityLabel + ' · ' + r.footer,
              isSubtle: true,
              spacing: 'None',
              wrap: true,
            },
            { type: 'FactSet', facts: r.facts.map(([title, value]) => ({ title, value })) },
          ],
          actions: [{ type: 'Action.OpenUrl', title: r.openLabel, url: r.url }],
        },
      },
    ],
  };
}

const PAGERDUTY_SEVERITY: Readonly<Record<NotificationSeverity, string>> = {
  info: 'info',
  warning: 'warning',
  critical: 'critical',
};

/** PagerDuty Events API v2 trigger; one alert per subject and event type. */
export function pagerDutyPayload(
  r: RenderedNotification,
  event: Pick<EventEnvelope, 'type' | 'subject' | 'time'>,
  routingKey: string,
): Record<string, unknown> {
  return {
    routing_key: routingKey,
    event_action: 'trigger',
    dedup_key: event.type + ':' + event.subject,
    payload: {
      summary: r.title,
      source: 'openmap',
      severity: PAGERDUTY_SEVERITY[r.severity],
      timestamp: event.time,
      custom_details: Object.fromEntries(r.facts),
    },
    links: [{ href: r.url, text: r.openLabel }],
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}

export interface EmailMessage {
  subject: string;
  text: string;
  html: string;
}

/** A plain-text and HTML email of the message; `dir` follows the language so Arabic reads right to left. */
export function emailMessage(r: RenderedNotification, dir: 'ltr' | 'rtl'): EmailMessage {
  const subject = '[' + r.severityLabel + '] ' + r.title;
  const text = [
    r.title,
    '',
    ...r.facts.map(([k, v]) => k + ': ' + v),
    '',
    r.openLabel + ': ' + r.url,
    '',
    r.footer,
  ].join('\r\n');
  const rows = r.facts
    .map(([k, v]) => '<tr><th align="start">' + escapeHtml(k) + '</th><td>' + escapeHtml(v) + '</td></tr>')
    .join('');
  const html =
    '<!doctype html><html dir="' +
    dir +
    '"><body><h2>' +
    escapeHtml(r.title) +
    '</h2><p>' +
    escapeHtml(r.severityLabel) +
    ' · ' +
    escapeHtml(r.footer) +
    '</p><table>' +
    rows +
    '</table><p><a href="' +
    escapeHtml(r.url) +
    '">' +
    escapeHtml(r.openLabel) +
    '</a></p></body></html>';
  return { subject, text, html };
}
