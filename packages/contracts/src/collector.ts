// REQ-CORE-002 — collector contract, version CONTRACT_VERSIONS.collector.
// A Discovery Node pulls CollectorJobs, runs a collector subprocess, and posts a CollectorResult.
import { z } from 'zod';
import { observedCiSchema, observedRelationshipSchema } from './ci.js';

/** Collector families. One directory per family under apps/collectors. */
export const COLLECTOR_FAMILIES = [
  'snmp',
  'ssh_cli',
  'wmi',
  'winrm',
  'ssh_agentless',
  'vmware',
  'hyperv',
  'kvm_libvirt',
  'nutanix_ahv',
  'oracle_vm',
  'kubernetes',
  'cloud_aws',
  'cloud_azure',
  'cloud_gcp',
  'netflow',
  'port_scan',
  /** Out-of-band hardware: HPE iLO, Dell iDRAC, Lenovo XClarity, Cisco CIMC and generic BMCs over Redfish, IPMI fallback. */
  'ipmi_redfish',
  /** Fibre Channel fabrics: Brocade FOS and Cisco MDS switches, zones, name server. */
  'fc_fabric',
  'nas',
  'object_storage',
  'dns',
  'dhcp',
  'ldap',
  'database',
  'storage',
  'pdu',
  'agent',
  'load_balancer',
  'certificate',
  'vulnerability_feed',
  /** SaaS inventories and SSO sign-in logs: Microsoft 365, Salesforce, ServiceNow, Workday, Google Workspace, Entra ID, Okta. */
  'saas',
  /** OS patch state and end-of-life: WSUS/Intune, Red Hat Satellite, Landscape, endoflife.date. */
  'os_patch',
] as const;
export const collectorFamilySchema = z.enum(COLLECTOR_FAMILIES);
export type CollectorFamily = z.infer<typeof collectorFamilySchema>;

export const CREDENTIAL_TYPES = [
  'none',
  'snmp_v2c',
  'snmp_v3',
  'password',
  'ssh_key',
  'api_token',
  'oauth_client',
  'certificate',
  'kubeconfig',
  'cloud_role',
] as const;
export const credentialTypeSchema = z.enum(CREDENTIAL_TYPES);

export const TARGET_KINDS = ['host', 'cidr', 'url', 'cluster', 'account', 'zone', 'flow_source'] as const;
export const targetSchema = z.object({
  kind: z.enum(TARGET_KINDS),
  value: z.string().min(1),
  /** Optional label used in evidence and errors; never used for identity. */
  label: z.string().optional(),
});
export type Target = z.infer<typeof targetSchema>;

/** Static description a collector binary prints with `--manifest`. */
export const collectorManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  family: collectorFamilySchema,
  version: z.string().min(1),
  language: z.enum(['go', 'python']),
  protocols: z.array(z.string().min(1)),
  credentialTypes: z.array(credentialTypeSchema),
  targetKinds: z.array(z.enum(TARGET_KINDS)).min(1),
  /** CI types this collector can emit; used to plan sweeps and validate results. */
  emits: z.array(z.string().min(1)),
  /** Which contract version this collector was built against. */
  contractVersion: z.string().min(1),
});
export type CollectorManifest = z.infer<typeof collectorManifestSchema>;

export const rateLimitSchema = z.object({
  /** Concurrent targets per job. */
  concurrency: z.number().int().positive(),
  /** Requests per second across the job; 0 means unlimited. */
  requestsPerSecond: z.number().min(0),
});

export const collectorJobSchema = z.object({
  jobId: z.uuid(),
  tenantId: z.uuid(),
  collectorId: z.string().min(1),
  nodeId: z.string().min(1),
  targets: z.array(targetSchema).min(1),
  /** OpenBao path of the credential; the Node resolves it, collectors never see the vault. */
  credentialRef: z.string().min(1).nullable(),
  credentialType: credentialTypeSchema,
  timeoutMs: z.number().int().positive(),
  rateLimit: rateLimitSchema,
  /** Collector-specific options validated by the collector against its own schema. */
  options: z.record(z.string(), z.unknown()),
  scheduledAt: z.iso.datetime(),
  contractVersion: z.string().min(1),
});
export type CollectorJob = z.infer<typeof collectorJobSchema>;

export const EVIDENCE_KINDS = ['snmp_walk', 'cli_output', 'api_response', 'flow_sample', 'scan_output', 'agent_report'] as const;
export const evidenceSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  target: targetSchema,
  /** SHA-256 of the raw evidence; raw bytes are stored by the Node under this digest. */
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().min(0),
  capturedAt: z.iso.datetime(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const COLLECTOR_ERROR_CODES = [
  'unreachable',
  'auth_failed',
  'timeout',
  'unsupported_device',
  'parse_error',
  'rate_limited',
  'permission_denied',
  'internal',
] as const;
export const collectorErrorSchema = z.object({
  target: targetSchema.nullable(),
  code: z.enum(COLLECTOR_ERROR_CODES),
  message: z.string().min(1),
  retryable: z.boolean(),
});

export const RESULT_STATUSES = ['success', 'partial', 'failed'] as const;

export const collectorResultSchema = z.object({
  jobId: z.uuid(),
  runId: z.uuid(),
  tenantId: z.uuid(),
  collectorId: z.string().min(1),
  nodeId: z.string().min(1),
  status: z.enum(RESULT_STATUSES),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  cis: z.array(observedCiSchema),
  relationships: z.array(observedRelationshipSchema),
  evidence: z.array(evidenceSchema),
  errors: z.array(collectorErrorSchema),
  metrics: z.object({
    targetsAttempted: z.number().int().min(0),
    targetsReached: z.number().int().min(0),
    cisEmitted: z.number().int().min(0),
    relationshipsEmitted: z.number().int().min(0),
    durationMs: z.number().int().min(0),
  }),
  contractVersion: z.string().min(1),
});
export type CollectorResult = z.infer<typeof collectorResultSchema>;
