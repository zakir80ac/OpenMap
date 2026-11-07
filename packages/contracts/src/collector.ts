// REQ-CORE-002 — collector contract, version CONTRACT_VERSIONS.collector.
// A Discovery Node pulls CollectorJobs, runs a collector subprocess, and posts a CollectorResult.
import { z } from 'zod';
import { metricSampleSchema, observedCiSchema, observedRelationshipSchema } from './ci.js';

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
  /** Oracle Cloud Infrastructure and Alibaba Cloud (collectors since REQ-DISC-010; families added in 0.6.0). */
  'cloud_oci',
  'cloud_alibaba',
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
  /** Vendor warranty and end-of-life lookups by serial (ADR-043): Dell TechDirect, Lenovo, Cisco SN2INFO and EoX. */
  'warranty',
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
  /** 0.6.0: a Google service-account key (Cloud and Workspace with domain-wide delegation). */
  'service_account',
  /** 0.6.0: an OCI API signing key. */
  'api_signing_key',
] as const;
export const credentialTypeSchema = z.enum(CREDENTIAL_TYPES);
export type CredentialType = z.infer<typeof credentialTypeSchema>;

/**
 * Field names a credential of each type carries in OpenBao (ADR-017). They are the keys the Go collectors read
 * (apps/collectors/internal/*: community, username/password, authProtocol…), so the setup wizard can validate a
 * credential set before storing it and a collector finds what it expects at dispatch. Values never leave the vault
 * except as the short-lived copy a Node receives with a job.
 */
export const CREDENTIAL_FIELDS: Record<CredentialType, { required: readonly string[]; optional: readonly string[]; secret: readonly string[] }> = {
  none: { required: [], optional: [], secret: [] },
  snmp_v2c: { required: ['community'], optional: [], secret: ['community'] },
  snmp_v3: { required: ['username', 'authProtocol', 'authPassphrase', 'privProtocol', 'privPassphrase'], optional: ['contextName'], secret: ['authPassphrase', 'privPassphrase'] },
  password: { required: ['username', 'password'], optional: ['domain'], secret: ['password'] },
  ssh_key: { required: ['username', 'privateKey'], optional: ['passphrase'], secret: ['privateKey', 'passphrase'] },
  api_token: { required: ['token'], optional: [], secret: ['token'] },
  oauth_client: { required: ['clientId', 'clientSecret'], optional: ['tenantId', 'tokenUrl', 'scope'], secret: ['clientSecret'] },
  certificate: { required: ['certificatePem', 'privateKeyPem'], optional: ['passphrase'], secret: ['privateKeyPem', 'passphrase'] },
  kubeconfig: { required: ['kubeconfig'], optional: [], secret: ['kubeconfig'] },
  cloud_role: { required: ['accessKeyId', 'accessKeySecret'], optional: ['roleArn', 'clientEmail', 'privateKeyPem', 'adminEmail', 'subscriptionId'], secret: ['accessKeySecret', 'privateKeyPem'] },
  service_account: { required: ['clientEmail', 'privateKeyPem'], optional: ['adminEmail'], secret: ['privateKeyPem'] },
  api_signing_key: { required: ['tenancyOcid', 'userOcid', 'fingerprint', 'privateKeyPem'], optional: [], secret: ['privateKeyPem'] },
};

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
  /** Collector ids are the apps/collectors/cmd directory names, snake_case (0.6.0 allows the underscore they use). */
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
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
  /** Measurements taken during the run (ADR-016, contract 0.2.0); absent from results of 0.1.0 collectors. */
  samples: z.array(metricSampleSchema).default([]),
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
