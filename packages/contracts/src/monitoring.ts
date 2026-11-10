// REQ-INT-012 (ADR-073) — monitoring event ingest: every supported tool's native alert payload normalised into one
// monitoring event. Prometheus Alertmanager (webhook payload version 4) is read as Alertmanager sends it; Zabbix (a
// webhook media type), Nagios / Icinga (a notification command), Datadog (a webhook integration), SolarWinds Orion
// (the "send a GET or POST request to a web server" alert action) and Splunk (the built-in webhook alert action) are
// read in the shapes those tools document for their macros and variables, with the parameter names given in ADR-073.
// Pure functions: the API parses, the engine never sees vendor payloads.
import { MONITORING } from '@openmap/constants';
import { z } from 'zod';
import type { INTEGRATION_VENDORS } from './integration.js';

type IntegrationVendor = (typeof INTEGRATION_VENDORS)[number];

export const MONITORING_VENDORS = [
  'prometheus_alertmanager',
  'zabbix',
  'nagios',
  'datadog',
  'solarwinds',
  'splunk',
] as const satisfies readonly IntegrationVendor[];
export type MonitoringVendor = (typeof MONITORING_VENDORS)[number];
export const monitoringVendorSchema = z.enum(MONITORING_VENDORS);

export function isMonitoringVendor(vendor: string): vendor is MonitoringVendor {
  return (MONITORING_VENDORS as readonly string[]).includes(vendor);
}

/** Vendors whose alerts have no resolve message: they clear after a time to live (ADR-073). */
export const POINT_IN_TIME_VENDORS: ReadonlySet<MonitoringVendor> = new Set<MonitoringVendor>(['splunk']);

export const MONITORING_STATUSES = ['firing', 'resolved'] as const;
export type MonitoringStatus = (typeof MONITORING_STATUSES)[number];

/** The incident severity scale (integration.ts securityAlertSchema, Prisma AlertSeverity). */
export const MONITORING_SEVERITIES = ['informational', 'low', 'medium', 'high', 'critical'] as const;
export type MonitoringSeverity = (typeof MONITORING_SEVERITIES)[number];

/** What a firing alert does to its CI's health. */
export const MONITORING_EFFECTS = ['down', 'degraded'] as const;
export type MonitoringEffect = (typeof MONITORING_EFFECTS)[number];

/**
 * What an alert can name the affected thing by, in the order the resolver tries them: most specific first, the short
 * hostname (the same in every domain) last.
 */
export const MONITORING_TARGET_KINDS = ['ci_id', 'fqdn', 'instance', 'ip', 'hostname'] as const;
export type MonitoringTargetKind = (typeof MONITORING_TARGET_KINDS)[number];

export const monitoringTargetSchema = z.object({
  kind: z.enum(MONITORING_TARGET_KINDS),
  value: z.string().min(1),
});
export type MonitoringTarget = z.infer<typeof monitoringTargetSchema>;

/** One alert as every adapter reports it. */
export const monitoringEventSchema = z.object({
  vendor: monitoringVendorSchema,
  /** Stable at the source: the same alert's firing and resolve messages carry the same fingerprint. */
  fingerprint: z.string().min(1),
  status: z.enum(MONITORING_STATUSES),
  severity: z.enum(MONITORING_SEVERITIES),
  title: z.string().min(1),
  description: z.string().nullable(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime().nullable(),
  targets: z.array(monitoringTargetSchema),
  labels: z.record(z.string(), z.string()),
  /** Link back to the alert in the tool that raised it. */
  sourceUrl: z.string().nullable(),
});
export type MonitoringEvent = z.infer<typeof monitoringEventSchema>;

/** Per-integration settings the ingest reads (IntegrationConfig.settings). */
export const monitoringSettingsSchema = z.object({
  /** Accept the credential's token as the last path segment (for senders that can set only a URL). */
  urlToken: z.boolean().default(false),
  /** The worst a firing alert may do to a CI: `none` keeps alerts for listing only. */
  maxEffect: z.enum(['down', 'degraded', 'none']).default('down'),
  /** Severity for alerts that name none. */
  defaultSeverity: z.enum(MONITORING_SEVERITIES).optional(),
  /** Point-in-time alerts clear after this many minutes (any vendor may set it; Splunk defaults to the constant). */
  resolveAfterMinutes: z.number().int().positive().optional(),
});
export type MonitoringSettings = z.infer<typeof monitoringSettingsSchema>;

export function monitoringSettingsOf(settings: Record<string, unknown>): MonitoringSettings {
  const parsed = monitoringSettingsSchema.safeParse(settings);
  return parsed.success ? parsed.data : monitoringSettingsSchema.parse({});
}

const EFFECT_BY_SEVERITY: Readonly<Record<MonitoringSeverity, MonitoringEffect | null>> = {
  critical: 'down',
  high: 'down',
  medium: 'degraded',
  low: 'degraded',
  informational: null,
};

/** The health a firing alert imposes on its CI, capped by the integration's `maxEffect`; null when it imposes none. */
export function monitoringEffect(
  severity: MonitoringSeverity,
  maxEffect: MonitoringSettings['maxEffect'] = 'down',
): MonitoringEffect | null {
  const effect = EFFECT_BY_SEVERITY[severity];
  if (effect === null || maxEffect === 'none') return null;
  return maxEffect === 'degraded' ? 'degraded' : effect;
}

/** Thrown when a payload is not the vendor's documented shape; the endpoint answers 400 with the message. */
export class MonitoringPayloadError extends Error {}

export interface ParsedMonitoringPayload {
  events: MonitoringEvent[];
  /** Messages that carry no state change OpenMap acts on (a Nagios downtime start, a Zabbix discovery event). */
  ignored: number;
}

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

const SEVERITY_WORDS: Readonly<Record<string, MonitoringSeverity>> = {
  critical: 'critical',
  crit: 'critical',
  disaster: 'critical',
  emergency: 'critical',
  fatal: 'critical',
  page: 'critical',
  p1: 'critical',
  sev1: 'critical',
  high: 'high',
  error: 'high',
  major: 'high',
  serious: 'high',
  p2: 'high',
  sev2: 'high',
  medium: 'medium',
  average: 'medium',
  warning: 'medium',
  warn: 'medium',
  moderate: 'medium',
  p3: 'medium',
  sev3: 'medium',
  low: 'low',
  minor: 'low',
  notice: 'low',
  p4: 'low',
  sev4: 'low',
  info: 'informational',
  informational: 'informational',
  information: 'informational',
  none: 'informational',
  ok: 'informational',
  p5: 'informational',
  sev5: 'informational',
};

/** Severity from a free-form word (`critical`, `warning`, `P2`, `Serious`), or null when it is not one. */
export function severityFromWord(word: unknown): MonitoringSeverity | null {
  if (typeof word !== 'string') return null;
  return SEVERITY_WORDS[word.trim().toLowerCase()] ?? null;
}

function text(value: unknown): string | null {
  if (typeof value === 'string') {
    const t = value.trim();
    return t === '' ? null : t;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function cap(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringLabels(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(recordOf(value))) {
    if (Object.keys(out).length >= MONITORING.maxLabels) break;
    const t = text(v);
    if (t !== null) out[k] = cap(t, MONITORING.labelValueMaxLength);
  }
  return out;
}

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/u;
const IPV6 = /^[0-9a-f:]+(?:%\w+)?$/iu;
const BRACKETED_WITH_PORT = /^\[([^\]]+)\](?::\d+)?$/u;
const HOST_WITH_PORT = /^([^:]+):\d+$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu;

/** The host part of an address, URL or `host:port` (Prometheus `instance` labels carry a port). */
export function hostOf(value: string): string {
  let v = value.trim();
  if (SCHEME.test(v)) {
    try {
      v = new URL(v).hostname;
    } catch {
      return v;
    }
  }
  const bracketed = BRACKETED_WITH_PORT.exec(v);
  if (bracketed?.[1] !== undefined) return bracketed[1];
  if (IPV6.test(v) && v.includes(':') && v.split(':').length > 2) return v;
  const withPort = HOST_WITH_PORT.exec(v);
  return withPort?.[1] ?? v;
}

/** Targets for one host-like value: an address, or an FQDN plus its short name, or a bare hostname. */
export function hostTargets(value: unknown, kind?: MonitoringTargetKind): MonitoringTarget[] {
  const raw = text(value);
  if (raw === null) return [];
  if (kind === 'ci_id') return UUID.test(raw) ? [{ kind: 'ci_id', value: raw.toLowerCase() }] : [];
  const host = hostOf(raw);
  if (host === '') return [];
  if (IPV4.test(host) || (host.includes(':') && IPV6.test(host))) return [{ kind: 'ip', value: host.toLowerCase() }];
  const lower = host.toLowerCase().replace(/\.$/u, '');
  if (lower.includes('.')) {
    const short = lower.split('.')[0] ?? '';
    const out: MonitoringTarget[] = [{ kind: kind === 'instance' ? 'instance' : 'fqdn', value: lower }];
    if (short !== '' && short !== lower) out.push({ kind: 'hostname', value: short });
    return out;
  }
  return [{ kind: kind === 'instance' ? 'instance' : 'hostname', value: lower }];
}

function uniqueTargets(list: readonly MonitoringTarget[]): MonitoringTarget[] {
  const seen = new Set<string>();
  const out: MonitoringTarget[] = [];
  for (const t of list) {
    const key = t.kind + '\u0000' + t.value;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MONITORING.maxTargets) break;
  }
  // The resolver tries targets in contract order: an explicit CI id first, an address last but one.
  return out.sort((a, b) => MONITORING_TARGET_KINDS.indexOf(a.kind) - MONITORING_TARGET_KINDS.indexOf(b.kind));
}

/** The keys a mapping and the CI lookup compare: the normalised target values. */
export function monitoringSourceKeys(targets: readonly MonitoringTarget[]): string[] {
  return [...new Set(targets.filter((t) => t.kind !== 'ci_id').map((t) => normalizeSourceKey(t.value)))];
}

export function normalizeSourceKey(value: string): string {
  return value.trim().toLowerCase();
}

function iso(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
  }
  const t = text(value);
  if (t === null) return fallback;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

/** Seconds or milliseconds since the epoch, as text or a number (Nagios $TIMET$ is seconds, Datadog $DATE ms). */
function epoch(value: unknown, fallback: string): string {
  const t = text(value);
  if (t === null || !/^\d+$/u.test(t)) return iso(value, fallback);
  const n = Number(t);
  const msThreshold = 1e11;
  const ms = n < msThreshold ? n * 1000 : n;
  return iso(ms, fallback);
}

const FNV_OFFSETS = [0x811c9dc5, 0x050c5d1f] as const;
const FNV_PRIME = 0x01000193;
const HEX = 16;
const WORD_HEX_DIGITS = 8;

/** A stable 64-bit FNV-1a digest (two 32-bit lanes) of the parts: no crypto API, so the console can import this file. */
function fingerprintOf(parts: readonly (string | null)[]): string {
  const input = parts.map((p) => p ?? '').join('\u0000');
  return FNV_OFFSETS.map((offset) => {
    let h = offset >>> 0;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, FNV_PRIME) >>> 0;
    }
    return h.toString(HEX).padStart(WORD_HEX_DIGITS, '0');
  }).join('');
}

function finish(
  vendor: MonitoringVendor,
  draft: Omit<MonitoringEvent, 'vendor' | 'title' | 'description'> & { title: string | null; description: string | null },
  fallbackTitle: string,
): MonitoringEvent {
  return monitoringEventSchema.parse({
    ...draft,
    vendor,
    title: cap(draft.title ?? fallbackTitle, MONITORING.titleMaxLength),
    description: draft.description === null ? null : cap(draft.description, MONITORING.descriptionMaxLength),
    targets: uniqueTargets(draft.targets),
  });
}

function requireObject(body: unknown, vendor: string): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw new MonitoringPayloadError(vendor + ' payload must be a JSON object');
  return body as Record<string, unknown>;
}

export interface ParseContext {
  /** When the request arrived (ISO): the start time of alerts that carry none. */
  receivedAt: string;
  /** Severity for alerts that name none. */
  defaultSeverity: MonitoringSeverity;
}

// ---------------------------------------------------------------------------------------------
// Prometheus Alertmanager — webhook_config payload, version 4
// ---------------------------------------------------------------------------------------------

const alertmanagerSchema = z.object({
  version: z.string(),
  status: z.string().optional(),
  externalURL: z.string().optional(),
  commonLabels: z.record(z.string(), z.string()).optional(),
  alerts: z.array(
    z.object({
      status: z.enum(MONITORING_STATUSES),
      labels: z.record(z.string(), z.string()),
      annotations: z.record(z.string(), z.string()).optional(),
      startsAt: z.string().optional(),
      endsAt: z.string().optional(),
      generatorURL: z.string().optional(),
      fingerprint: z.string().optional(),
    }),
  ),
});

/** Label names Alertmanager alerts commonly name their host by, in the order they are read. */
export const ALERTMANAGER_TARGET_LABELS: ReadonlyArray<{ label: string; kind?: MonitoringTargetKind }> = [
  { label: 'openmap_ci_id', kind: 'ci_id' },
  { label: 'fqdn' },
  { label: 'hostname' },
  { label: 'host' },
  { label: 'nodename' },
  { label: 'node' },
  { label: 'instance', kind: 'instance' },
  { label: 'ip' },
  { label: 'address' },
];

export function parseAlertmanager(body: unknown, ctx: ParseContext): ParsedMonitoringPayload {
  const parsed = alertmanagerSchema.safeParse(body);
  if (!parsed.success) throw new MonitoringPayloadError('not an Alertmanager webhook payload: ' + parsed.error.issues[0]?.message);
  if (parsed.data.version !== MONITORING.alertmanagerWebhookVersion)
    throw new MonitoringPayloadError('Alertmanager webhook version ' + parsed.data.version + ' is not supported');
  const events = parsed.data.alerts.map((a) => {
    const labels = { ...(parsed.data.commonLabels ?? {}), ...a.labels };
    const annotations = a.annotations ?? {};
    const endsAt = a.endsAt === undefined || a.endsAt.startsWith(MONITORING.zeroTimePrefix) ? null : iso(a.endsAt, ctx.receivedAt);
    const name = text(labels['alertname']);
    const summary = text(annotations['summary']);
    return finish(
      'prometheus_alertmanager',
      {
        fingerprint: a.fingerprint ?? fingerprintOf(Object.entries(labels).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, v]) => k + '=' + v)),
        status: a.status,
        severity: severityFromWord(labels['severity']) ?? severityFromWord(labels['priority']) ?? ctx.defaultSeverity,
        title: name === null ? summary : summary === null ? name : name + ': ' + summary,
        description: text(annotations['description']) ?? text(annotations['message']),
        startsAt: iso(a.startsAt, ctx.receivedAt),
        endsAt: a.status === 'resolved' ? (endsAt ?? ctx.receivedAt) : null,
        targets: ALERTMANAGER_TARGET_LABELS.flatMap((t) => hostTargets(labels[t.label], t.kind)),
        labels: stringLabels(labels),
        sourceUrl: text(a.generatorURL) ?? text(parsed.data.externalURL),
      },
      'Alertmanager alert',
    );
  });
  return { events, ignored: 0 };
}

// ---------------------------------------------------------------------------------------------
// Zabbix — webhook media type; parameters named as Zabbix's own webhook templates name them
// ---------------------------------------------------------------------------------------------

/** {EVENT.NSEVERITY}: 0 not classified, 1 information, 2 warning, 3 average, 4 high, 5 disaster. */
export const ZABBIX_SEVERITY_BY_LEVEL: readonly MonitoringSeverity[] = ['informational', 'informational', 'low', 'medium', 'high', 'critical'];
const ZABBIX_SEVERITY_NAMES: Readonly<Record<string, MonitoringSeverity>> = {
  'not classified': 'informational',
  information: 'informational',
  warning: 'low',
  average: 'medium',
  high: 'high',
  disaster: 'critical',
};
/** {EVENT.SOURCE} 0 is a trigger event; discovery, autoregistration and internal events change no health. */
const ZABBIX_TRIGGER_SOURCE = '0';
const ZABBIX_PROBLEM = '1';
const ZABBIX_DATE = /^(\d{4})\.(\d{2})\.(\d{2})$/u;
const ZABBIX_TIME = /^\d{2}:\d{2}:\d{2}$/u;

function zabbixInstant(date: unknown, time: unknown, fallback: string): string {
  const d = ZABBIX_DATE.exec(text(date) ?? '');
  const t = text(time);
  if (d === null || t === null || !ZABBIX_TIME.test(t)) return fallback;
  return iso(d[1] + '-' + d[2] + '-' + d[3] + 'T' + t + 'Z', fallback);
}

function zabbixTags(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      const r = recordOf(item);
      const tag = text(r['tag']);
      if (tag !== null) out[tag] = text(r['value']) ?? '';
    }
    return out;
  }
  const raw = text(value);
  if (raw === null) return out;
  for (const part of raw.split(',')) {
    const [k, ...rest] = part.split(':');
    const key = k?.trim() ?? '';
    if (key !== '') out[key] = rest.join(':').trim();
  }
  return out;
}

export function parseZabbix(body: unknown, ctx: ParseContext): ParsedMonitoringPayload {
  const p = requireObject(body, 'Zabbix');
  const eventId = text(p['event_id']);
  if (eventId === null) throw new MonitoringPayloadError('Zabbix payload has no event_id');
  const source = text(p['event_source']);
  if (source !== null && source !== ZABBIX_TRIGGER_SOURCE) return { events: [], ignored: 1 };
  const value = text(p['event_value']);
  if (value === null) throw new MonitoringPayloadError('Zabbix payload has no event_value');
  const level = Number(text(p['event_nseverity']) ?? Number.NaN);
  const severity =
    (Number.isInteger(level) ? ZABBIX_SEVERITY_BY_LEVEL[level] : undefined) ??
    ZABBIX_SEVERITY_NAMES[(text(p['event_severity']) ?? '').toLowerCase()] ??
    ctx.defaultSeverity;
  const firing = value === ZABBIX_PROBLEM;
  const tags = zabbixTags(p['event_tags']);
  const triggerId = text(p['trigger_id']);
  const base = text(p['zabbix_url']);
  const startsAt = zabbixInstant(p['event_date'], p['event_time'], ctx.receivedAt);
  return {
    events: [
      finish(
        'zabbix',
        {
          fingerprint: eventId,
          status: firing ? 'firing' : 'resolved',
          severity,
          title: text(p['event_name']) ?? text(p['trigger_name']),
          description: text(p['alert_message']) ?? text(p['event_opdata']) ?? text(p['trigger_description']),
          startsAt,
          endsAt: firing ? null : zabbixInstant(p['event_recovery_date'], p['event_recovery_time'], ctx.receivedAt),
          targets: [
            ...hostTargets(tags['openmap_ci_id'], 'ci_id'),
            ...hostTargets(p['host_dns']),
            ...hostTargets(p['host_host']),
            ...hostTargets(p['host_name']),
            ...hostTargets(p['host_ip']),
          ],
          labels: stringLabels({ ...tags, trigger_id: triggerId, host: text(p['host_host']) ?? text(p['host_name']) }),
          sourceUrl:
            base !== null && triggerId !== null
              ? base.replace(/\/+$/u, '') + '/tr_events.php?triggerid=' + encodeURIComponent(triggerId) + '&eventid=' + encodeURIComponent(eventId)
              : base,
        },
        'Zabbix problem',
      ),
    ],
    ignored: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Nagios / Icinga — a notification command posting the standard macros as JSON
// ---------------------------------------------------------------------------------------------

/** $NOTIFICATIONTYPE$ values that raise or keep an alert; RECOVERY resolves it; the rest change no state. */
const NAGIOS_FIRING_TYPES = new Set(['problem', 'acknowledgement', 'flappingstart', 'custom']);
const NAGIOS_RECOVERY = 'recovery';
const NAGIOS_HOST_SEVERITY: Readonly<Record<string, MonitoringSeverity>> = { down: 'critical', unreachable: 'high', up: 'informational' };
const NAGIOS_SERVICE_SEVERITY: Readonly<Record<string, MonitoringSeverity>> = {
  critical: 'high',
  warning: 'medium',
  unknown: 'low',
  ok: 'informational',
};
const NAGIOS_OK_STATES = new Set(['ok', 'up']);

export function parseNagios(body: unknown, ctx: ParseContext): ParsedMonitoringPayload {
  const p = requireObject(body, 'Nagios');
  const host = text(p['host_name']) ?? text(p['hostname']);
  if (host === null) throw new MonitoringPayloadError('Nagios payload has no host_name');
  const type = (text(p['notification_type']) ?? '').toLowerCase();
  const service = text(p['service_description']) ?? text(p['service']);
  const state = (text(service === null ? p['host_state'] : p['service_state']) ?? text(p['state']) ?? '').toLowerCase();
  const recovered = type === NAGIOS_RECOVERY || (type === '' && NAGIOS_OK_STATES.has(state));
  if (!recovered && !(NAGIOS_FIRING_TYPES.has(type) || type === '')) return { events: [], ignored: 1 };
  const severity =
    (service === null ? NAGIOS_HOST_SEVERITY[state] : NAGIOS_SERVICE_SEVERITY[state]) ??
    severityFromWord(p['severity']) ??
    ctx.defaultSeverity;
  const at = epoch(p['timestamp'], ctx.receivedAt);
  const output = text(p['output']);
  return {
    events: [
      finish(
        'nagios',
        {
          fingerprint: service === null ? 'host:' + host.toLowerCase() : 'service:' + host.toLowerCase() + ':' + service,
          status: recovered ? 'resolved' : 'firing',
          severity,
          title: ((service === null ? host : host + ' / ' + service) + ' ' + state.toUpperCase()).trim(),
          description: output === null ? text(p['long_output']) : output,
          startsAt: at,
          endsAt: recovered ? at : null,
          targets: [...hostTargets(p['openmap_ci_id'], 'ci_id'), ...hostTargets(host), ...hostTargets(p['host_alias']), ...hostTargets(p['host_address'])],
          labels: stringLabels({ host, service, state, notification_type: type, problem_id: text(p['problem_id']) }),
          sourceUrl: text(p['url']),
        },
        'Nagios notification',
      ),
    ],
    ignored: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Datadog — webhook integration with the template variables listed in ADR-073
// ---------------------------------------------------------------------------------------------

const DATADOG_RECOVERED = 'recovered';
const DATADOG_WARN = new Set(['warn', 're-warn']);
const DATADOG_TYPE_SEVERITY: Readonly<Record<string, MonitoringSeverity>> = {
  error: 'high',
  warning: 'medium',
  info: 'informational',
  success: 'informational',
};

function datadogTags(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const list = Array.isArray(value) ? value : (text(value) ?? '').split(',');
  for (const item of list) {
    const t = text(item);
    if (t === null) continue;
    const i = t.indexOf(':');
    if (i > 0) out[t.slice(0, i)] = t.slice(i + 1);
    else out[t] = '';
  }
  return out;
}

export function parseDatadog(body: unknown, ctx: ParseContext): ParsedMonitoringPayload {
  const p = requireObject(body, 'Datadog');
  const alertId = text(p['alert_id']) ?? text(p['id']);
  if (alertId === null) throw new MonitoringPayloadError('Datadog payload has no alert_id');
  const transition = (text(p['alert_transition']) ?? '').toLowerCase();
  const tags = datadogTags(p['tags']);
  const hostname = text(p['hostname']) ?? text(tags['host']);
  const resolved = transition === DATADOG_RECOVERED;
  const severity =
    severityFromWord(p['priority']) ??
    (DATADOG_WARN.has(transition) ? 'medium' : null) ??
    DATADOG_TYPE_SEVERITY[(text(p['alert_type']) ?? '').toLowerCase()] ??
    ctx.defaultSeverity;
  const at = epoch(p['date'], ctx.receivedAt);
  return {
    events: [
      finish(
        'datadog',
        {
          fingerprint: text(p['alert_cycle_key']) ?? alertId + ':' + (text(p['aggreg_key']) ?? hostname ?? ''),
          status: resolved ? 'resolved' : 'firing',
          severity,
          title: text(p['title']),
          description: text(p['body']),
          startsAt: at,
          endsAt: resolved ? at : null,
          targets: [...hostTargets(tags['openmap_ci_id'], 'ci_id'), ...hostTargets(hostname)],
          labels: stringLabels({ ...tags, alert_id: alertId, transition: text(p['alert_transition']) }),
          sourceUrl: text(p['link']),
        },
        'Datadog alert',
      ),
    ],
    ignored: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// SolarWinds Orion — alert action "Send a GET or POST request to a web server", trigger and reset
// ---------------------------------------------------------------------------------------------

const ORION_SEVERITY: Readonly<Record<string, MonitoringSeverity>> = {
  critical: 'critical',
  serious: 'high',
  warning: 'medium',
  notice: 'low',
  informational: 'informational',
};
const ORION_RESET = new Set(['reset', 'resolved', 'cleared']);

export function parseSolarWinds(body: unknown, ctx: ParseContext): ParsedMonitoringPayload {
  const p = requireObject(body, 'SolarWinds');
  const name = text(p['alert_name']);
  const node = text(p['node_name']);
  const objectId = text(p['alert_object_id']);
  if (name === null && objectId === null) throw new MonitoringPayloadError('SolarWinds payload has no alert_name or alert_object_id');
  const reset = ORION_RESET.has((text(p['action']) ?? '').toLowerCase());
  const at = iso(p['triggered_at'], ctx.receivedAt);
  return {
    events: [
      finish(
        'solarwinds',
        {
          fingerprint: objectId ?? fingerprintOf([name, node]),
          status: reset ? 'resolved' : 'firing',
          severity: ORION_SEVERITY[(text(p['severity']) ?? '').toLowerCase()] ?? ctx.defaultSeverity,
          title: name === null ? node : node === null ? name : name + ': ' + node,
          description: text(p['message']),
          startsAt: at,
          endsAt: reset ? ctx.receivedAt : null,
          targets: [...hostTargets(p['openmap_ci_id'], 'ci_id'), ...hostTargets(p['dns']), ...hostTargets(node), ...hostTargets(p['ip_address'])],
          labels: stringLabels({ alert_name: name, node, entity_type: text(p['entity_type']), alert_active_id: text(p['alert_active_id']) }),
          sourceUrl: text(p['details_url']),
        },
        'SolarWinds alert',
      ),
    ],
    ignored: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Splunk — the built-in webhook alert action: { result, sid, results_link, search_name, owner, app }
// ---------------------------------------------------------------------------------------------

/** Result fields Splunk searches (and the CIM) commonly name the affected host by. */
export const SPLUNK_TARGET_FIELDS: ReadonlyArray<{ field: string; kind?: MonitoringTargetKind }> = [
  { field: 'openmap_ci_id', kind: 'ci_id' },
  { field: 'fqdn' },
  { field: 'dest_host' },
  { field: 'dest' },
  { field: 'dvc' },
  { field: 'host' },
  { field: 'hostname' },
  { field: 'dest_ip' },
  { field: 'ip' },
];
const SPLUNK_RESOLVED = new Set(['resolved', 'closed', 'ok', 'cleared', 'recovered']);

export function parseSplunk(body: unknown, ctx: ParseContext): ParsedMonitoringPayload {
  const p = requireObject(body, 'Splunk');
  const search = text(p['search_name']);
  if (search === null) throw new MonitoringPayloadError('Splunk payload has no search_name');
  const result = recordOf(p['result']);
  const targets = SPLUNK_TARGET_FIELDS.flatMap((f) => hostTargets(result[f.field], f.kind));
  const status = (text(result['status']) ?? text(result['state']) ?? '').toLowerCase();
  return {
    events: [
      finish(
        'splunk',
        {
          fingerprint: fingerprintOf([search, ...targets.map((t) => t.value)]),
          status: SPLUNK_RESOLVED.has(status) ? 'resolved' : 'firing',
          severity: severityFromWord(result['severity']) ?? severityFromWord(result['urgency']) ?? ctx.defaultSeverity,
          title: search,
          description: text(result['message']) ?? text(result['description']) ?? text(result['_raw']),
          startsAt: epoch(result['_time'], ctx.receivedAt),
          endsAt: SPLUNK_RESOLVED.has(status) ? ctx.receivedAt : null,
          targets,
          labels: stringLabels({ ...result, sid: text(p['sid']), app: text(p['app']), owner: text(p['owner']) }),
          sourceUrl: text(p['results_link']),
        },
        'Splunk alert',
      ),
    ],
    ignored: 0,
  };
}

const PARSERS: Readonly<Record<MonitoringVendor, (body: unknown, ctx: ParseContext) => ParsedMonitoringPayload>> = {
  prometheus_alertmanager: parseAlertmanager,
  zabbix: parseZabbix,
  nagios: parseNagios,
  datadog: parseDatadog,
  solarwinds: parseSolarWinds,
  splunk: parseSplunk,
};

/** Parses one request body of a vendor into monitoring events; throws MonitoringPayloadError when it is not its shape. */
export function parseMonitoringPayload(vendor: MonitoringVendor, body: unknown, ctx: ParseContext): ParsedMonitoringPayload {
  const parsed = PARSERS[vendor](body, ctx);
  if (parsed.events.length > MONITORING.maxAlertsPerRequest)
    throw new MonitoringPayloadError('a request may carry at most ' + String(MONITORING.maxAlertsPerRequest) + ' alerts');
  return parsed;
}
