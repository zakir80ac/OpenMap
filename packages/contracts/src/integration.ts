// REQ-INT-001 — integration contract: ITSM, SIEM/SOAR, monitoring, notification, automation,
// warranty, identity and finance adapters. Every adapter is tenant-enabled, off in the airgap
// profile, authenticates via an OpenBao secret reference, and records every delivery.
import { z } from 'zod';

export const INTEGRATION_CATEGORIES = ['itsm', 'siem', 'soar', 'monitoring', 'notification', 'automation', 'warranty', 'identity', 'finance', 'iac'] as const;
export const integrationCategorySchema = z.enum(INTEGRATION_CATEGORIES);

/** Vendor adapters shipped in the single release. Adding one is a tracker row, not a contract change. */
export const INTEGRATION_VENDORS = [
  'servicenow', 'jira_service_management', 'bmc_helix', 'freshservice', 'zendesk',
  'splunk', 'microsoft_sentinel', 'ibm_qradar', 'elastic_security', 'wazuh', 'cortex_xsoar',
  'zabbix', 'prometheus_alertmanager', 'datadog', 'solarwinds', 'nagios',
  'pagerduty', 'opsgenie', 'slack', 'microsoft_teams', 'email_smtp', 'webhook',
  'ansible_awx', 'puppet', 'saltstack', 'terraform',
  'dell_techdirect', 'hpe_warranty', 'lenovo_warranty', 'cisco_sntc', 'ibm_support', 'endoflife_date',
  'entra_id', 'okta', 'active_directory',
  'sap', 'coupa', 'oracle_erp',
] as const;
export const integrationVendorSchema = z.enum(INTEGRATION_VENDORS);

export const DIRECTIONS = ['inbound', 'outbound', 'bidirectional'] as const;

export const integrationConfigSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  category: integrationCategorySchema,
  vendor: integrationVendorSchema,
  name: z.string().min(1),
  enabled: z.boolean(),
  direction: z.enum(DIRECTIONS),
  /** Base URL of the remote system; validated as a URL, never embedded in code. */
  endpoint: z.url(),
  /** OpenBao path holding credentials; the adapter never stores secrets. */
  credentialRef: z.string().min(1),
  /** Vendor-specific settings validated by the adapter's own schema. */
  settings: z.record(z.string(), z.unknown()),
  /** Field mappings OpenMap → remote and remote → OpenMap, as JSONPath-like dotted paths. */
  fieldMappings: z.array(z.object({ from: z.string().min(1), to: z.string().min(1), direction: z.enum(['out', 'in']) })),
  /** CI type to remote class mapping for CMDB sync adapters. */
  classMappings: z.array(z.object({ ciType: z.string().min(1), remoteClass: z.string().min(1) })),
  /** Event types this adapter subscribes to (see event.ts EVENT_TYPES). */
  subscribedEvents: z.array(z.string().min(1)),
  schedule: z.object({ cron: z.string().min(1) }).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type IntegrationConfig = z.infer<typeof integrationConfigSchema>;

export const integrationStatusSchema = z.object({
  integrationId: z.uuid(),
  health: z.enum(['healthy', 'warning', 'failing', 'disabled']),
  lastSuccessAt: z.iso.datetime().nullable(),
  lastErrorAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  /** Credential or token expiry if the remote system exposes it. */
  credentialExpiresAt: z.iso.datetime().nullable(),
  deliveredLastHour: z.number().int().min(0),
  failedLastHour: z.number().int().min(0),
});
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;

export const DELIVERY_STATES = ['pending', 'delivered', 'failed', 'retrying', 'dead_letter'] as const;

/** One message to or from a remote system, kept for audit and replay. */
export const integrationDeliverySchema = z.object({
  id: z.uuid(),
  integrationId: z.uuid(),
  tenantId: z.uuid(),
  direction: z.enum(['out', 'in']),
  eventId: z.uuid().nullable(),
  remoteId: z.string().nullable(),
  state: z.enum(DELIVERY_STATES),
  attempts: z.number().int().min(0),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  responseCode: z.number().int().nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});
export type IntegrationDelivery = z.infer<typeof integrationDeliverySchema>;

/** Link between an OpenMap incident and its records in ITSM and SIEM systems. */
export const incidentLinkSchema = z.object({
  incidentId: z.uuid(),
  integrationId: z.uuid(),
  remoteId: z.string().min(1),
  remoteUrl: z.url().nullable(),
  remoteState: z.string().min(1),
  syncedAt: z.iso.datetime(),
});
export type IncidentLink = z.infer<typeof incidentLinkSchema>;

/** A security alert received from a SIEM, resolved to CIs for enrichment and response. */
export const securityAlertSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  integrationId: z.uuid(),
  remoteId: z.string().min(1),
  severity: z.enum(['informational', 'low', 'medium', 'high', 'critical']),
  title: z.string().min(1),
  observedAt: z.iso.datetime(),
  indicators: z.array(z.object({ kind: z.enum(['ip', 'mac', 'hostname', 'user', 'hash', 'url']), value: z.string().min(1) })),
  resolvedCiIds: z.array(z.uuid()),
  affectedServiceCiIds: z.array(z.uuid()),
  responseActions: z.array(z.object({ playbook: z.string().min(1), integrationId: z.uuid(), state: z.enum(DELIVERY_STATES) })),
});
export type SecurityAlert = z.infer<typeof securityAlertSchema>;
