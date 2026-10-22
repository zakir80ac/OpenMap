// REQ-CORE-001 — Configuration Item (CI) contract, version CONTRACT_VERSIONS.ci.
// Every store (Postgres, Memgraph, ClickHouse, Meilisearch) and every collector speaks this shape.
import { z } from 'zod';

/**
 * Layers give layered visibility: every CI lives in exactly one layer, derived from its type
 * (CI_TYPE_LAYER) unless a user labels it. Order is bottom (facilities) to top (applications).
 */
export const CI_LAYERS = [
  'dc',
  'network_security',
  'hardware',
  'storage',
  'virtualization',
  'cloud',
  'os',
  'containers',
  'databases',
  'applications',
  'saas',
  'unknown',
] as const;
export const ciLayerSchema = z.enum(CI_LAYERS);
export type CiLayer = z.infer<typeof ciLayerSchema>;

/** Every CI class OpenMap models. Adding one is a contract change (ADR + tracker row). */
export const CI_TYPES = [
  // compute and hardware
  'host',
  'chassis',
  'blade',
  'bmc',
  'hypervisor',
  'vm_cluster',
  'vm',
  'operating_system',
  'container',
  'k8s_cluster',
  'k8s_namespace',
  'k8s_workload',
  'k8s_service',
  'container_registry',
  // network
  'network_device',
  'interface',
  'port',
  'vlan',
  'vrf',
  'ip_address',
  'subnet',
  'dns_zone',
  'dns_record',
  'dhcp_scope',
  'dhcp_lease',
  'load_balancer',
  'firewall_rule',
  'site_link',
  // storage and data
  'storage_array',
  'lun',
  'fc_switch',
  'fc_fabric',
  'fc_zone',
  'nas_share',
  'object_bucket',
  'database',
  'database_cluster',
  'certificate',
  // applications and services
  'application',
  'application_component',
  'listening_service',
  'business_service',
  'software',
  'software_instance',
  'licence',
  'vulnerability',
  // facilities
  'site',
  'building',
  'room',
  'row',
  'rack',
  'pdu',
  'power_feed',
  'power_circuit',
  'ups',
  'cooling_unit',
  'cable',
  'patch_panel',
  // cloud, SaaS and identity
  'cloud_account',
  'cloud_resource',
  'saas_application',
  'saas_tenant',
  'user_account',
  'service_account',
  // commercial
  'vendor',
  'contract',
  'cost_centre',
  // discovered but not yet classified; users label and promote these
  'unknown',
] as const;
export const ciTypeSchema = z.enum(CI_TYPES);
export type CiType = z.infer<typeof ciTypeSchema>;

/** Default layer for each CI type. Cross-cutting records (software, licence, vulnerability, vendor) attach to the layer of the CI they describe. */
export const CI_TYPE_LAYER: Record<CiType, CiLayer> = {
  host: 'hardware',
  chassis: 'hardware',
  blade: 'hardware',
  bmc: 'hardware',
  hypervisor: 'virtualization',
  vm_cluster: 'virtualization',
  vm: 'virtualization',
  operating_system: 'os',
  container: 'containers',
  k8s_cluster: 'containers',
  k8s_namespace: 'containers',
  k8s_workload: 'containers',
  k8s_service: 'containers',
  container_registry: 'containers',
  network_device: 'network_security',
  interface: 'network_security',
  port: 'network_security',
  vlan: 'network_security',
  vrf: 'network_security',
  ip_address: 'network_security',
  subnet: 'network_security',
  dns_zone: 'network_security',
  dns_record: 'network_security',
  dhcp_scope: 'network_security',
  dhcp_lease: 'network_security',
  load_balancer: 'network_security',
  firewall_rule: 'network_security',
  site_link: 'network_security',
  storage_array: 'storage',
  lun: 'storage',
  fc_switch: 'storage',
  fc_fabric: 'storage',
  fc_zone: 'storage',
  nas_share: 'storage',
  object_bucket: 'storage',
  database: 'databases',
  database_cluster: 'databases',
  certificate: 'network_security',
  application: 'applications',
  application_component: 'applications',
  listening_service: 'applications',
  business_service: 'applications',
  software: 'applications',
  software_instance: 'applications',
  licence: 'applications',
  vulnerability: 'applications',
  site: 'dc',
  building: 'dc',
  room: 'dc',
  row: 'dc',
  rack: 'dc',
  pdu: 'dc',
  power_feed: 'dc',
  power_circuit: 'dc',
  ups: 'dc',
  cooling_unit: 'dc',
  cable: 'dc',
  patch_panel: 'dc',
  cloud_account: 'cloud',
  cloud_resource: 'cloud',
  saas_application: 'saas',
  saas_tenant: 'saas',
  user_account: 'applications',
  service_account: 'applications',
  vendor: 'applications',
  contract: 'applications',
  cost_centre: 'applications',
  unknown: 'unknown',
};

/** Short-code prefix per layer: codes like NET-ARISTA-SPINE1 are what people say aloud in incidents. */
export const LAYER_CODE_PREFIX: Record<CiLayer, string> = {
  dc: 'FAC',
  network_security: 'NET',
  hardware: 'SRV',
  storage: 'STO',
  virtualization: 'VIRT',
  cloud: 'CLOUD',
  os: 'OS',
  containers: 'K8S',
  databases: 'DB',
  applications: 'APP',
  saas: 'SAAS',
  unknown: 'UNK',
};

/** Business services get their own prefix regardless of layer. */
export const BUSINESS_SERVICE_CODE_PREFIX = 'BS';

/** The one metric every card and table shows for a CI of this layer. */
export const LAYER_HEADLINE_METRIC: Record<CiLayer, { key: string; label: string; unit: string }> = {
  dc: { key: 'pue', label: 'PUE', unit: '' },
  network_security: { key: 'throughputGbps', label: 'Traffic', unit: 'Gbps' },
  hardware: { key: 'cpuPercent', label: 'Host load', unit: '%' },
  storage: { key: 'iops', label: 'IOPS', unit: '' },
  virtualization: { key: 'cpuPercent', label: 'CPU', unit: '%' },
  cloud: { key: 'loadPercent', label: 'Load', unit: '%' },
  os: { key: 'patchCompliancePercent', label: 'Patched', unit: '%' },
  containers: { key: 'cpuPercent', label: 'CPU', unit: '%' },
  databases: { key: 'iops', label: 'IOPS', unit: '' },
  applications: { key: 'apdex', label: 'Apdex', unit: '' },
  saas: { key: 'seatUtilisationPercent', label: 'Seats used', unit: '%' },
  unknown: { key: 'lastSeenDays', label: 'Last seen', unit: 'd' },
};

/** Generates a CI short code: layer prefix plus an upper-case slug of the name, capped for display. */
export function ciCode(layer: CiLayer, type: CiType, name: string, maxSlugLength = 24): string {
  const prefix = type === 'business_service' ? BUSINESS_SERVICE_CODE_PREFIX : LAYER_CODE_PREFIX[layer];
  const slug = name
    .toUpperCase()
    .replace(/\.[A-Z0-9.-]*$/u, '')
    .replace(/[^A-Z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, maxSlugLength)
    .replace(/-+$/u, '');
  return prefix + '-' + (slug.length ? slug : 'UNNAMED');
}

/** A user-supplied classification for a CI discovered as `unknown`, or an override of the derived layer. */
export const userLabelSchema = z.object({
  title: z.string().min(1),
  description: z.string(),
  layer: ciLayerSchema,
  /** Optional reclassification of the type once the user knows what the CI is. */
  type: ciTypeSchema.optional(),
  labelledBy: z.string().min(1),
  labelledAt: z.iso.datetime(),
});
export type UserLabel = z.infer<typeof userLabelSchema>;

/** Directed relationship classes. Direction is always from → to as named. */
export const RELATIONSHIP_TYPES = [
  'depends_on',
  'runs_on',
  'hosted_on',
  'contains',
  'member_of',
  'connected_to',
  'cabled_to',
  'located_in',
  'powered_by',
  'cooled_by',
  'uses_ip',
  'in_subnet',
  'in_vlan',
  'resolves_to',
  'leased_to',
  'installed_on',
  'licensed_by',
  'affected_by',
  'part_of_service',
  'communicates_with',
  'mounted_on',
  'backed_by',
  'owns',
  'manages',
  'billed_to',
  'secured_by',
  'covered_by',
  'supported_by',
  'assigned_to',
  'spare_for',
  'zoned_with',
  'presented_to',
  'replicates_to',
] as const;
export const relationshipTypeSchema = z.enum(RELATIONSHIP_TYPES);
export type RelationshipType = z.infer<typeof relationshipTypeSchema>;

export const LIFECYCLES = ['discovered', 'managed', 'planned', 'retired'] as const;
export const lifecycleSchema = z.enum(LIFECYCLES);

/** Attribute values are JSON scalars or arrays of scalars; nested objects go in their own CI. */
export const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const attributeValueSchema = z.union([scalarSchema, z.array(scalarSchema)]);
export const attributesSchema = z.record(z.string().min(1), attributeValueSchema);
export type Attributes = z.infer<typeof attributesSchema>;

/** Where an observation came from. confidence is 0..1 and drives reconciliation precedence. */
export const provenanceSchema = z.object({
  collectorId: z.string().min(1),
  nodeId: z.string().min(1),
  runId: z.string().min(1),
  confidence: z.number().min(0).max(1),
});
export type Provenance = z.infer<typeof provenanceSchema>;

export const externalIdSchema = z.object({
  source: z.string().min(1),
  id: z.string().min(1),
});

/**
 * Identity keys that are unique on their own across the whole estate. Any other identity key
 * (ifIndex, name, vlanId, port…) only identifies a CI together with the rest of its tuple.
 */
export const GLOBAL_IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'serialNumber', 'systemUuid', 'fqdn', 'primaryMac', 'instanceUuid', 'chassisId', 'clusterUid', 'uid', 'containerId',
  'managementIp', 'wwn', 'wwnn', 'fabricWwn', 'fingerprintSha256', 'cveId', 'licenceKeyDigest', 'resourceId', 'url',
  'principalName', 'contractNumber', 'circuitId', 'address', 'cidr', 'moRef', 'clusterId', 'accountId', 'tenantId',
]);

/**
 * Attribute names DCIM collectors and the synthetic estate use for rack placement and power (REQ-DCIM-001). Each
 * entry lists the accepted names in precedence order: the first is what collectors emit, the rest are accepted
 * synonyms. Placement attributes live on the located_in / mounted_on relationship, falling back to the device.
 */
export const DCIM_ATTRIBUTES = {
  /** Rack height in rack units. */
  rackUnits: ['heightU', 'units'],
  /** Lowest rack unit a device occupies. */
  position: ['uPosition', 'startUnit'],
  /** Device height in rack units. */
  height: ['heightU', 'heightUnits'],
  face: ['face'],
  ratedWatts: ['ratedWatts'],
  currentWatts: ['currentWatts'],
  /** PDU rating and measurement as the SNMP collectors report them; watts derive from amps × volts and kW × 1000. */
  ratedAmps: ['ratedAmps'],
  inputVoltage: ['inputVoltage'],
  measuredKw: ['measuredKw'],
  /** Room or rack design power in kW. */
  designKw: ['designKw'],
} as const;

/** Identity keys per type: the attribute names reconciliation matches on, in precedence order. */
export const CI_IDENTITY_KEYS: Record<CiType, readonly string[]> = {
  host: ['serialNumber', 'systemUuid', 'fqdn', 'primaryMac'],
  chassis: ['serialNumber'],
  blade: ['chassisRef', 'bay', 'serialNumber'],
  bmc: ['managementIp', 'serialNumber'],
  hypervisor: ['platform', 'hostRef', 'moRef'],
  vm_cluster: ['platform', 'clusterId'],
  vm: ['instanceUuid', 'hypervisorRef', 'fqdn'],
  operating_system: ['hostRef', 'family', 'version'],
  saas_application: ['vendor', 'product', 'tenantRef'],
  saas_tenant: ['vendor', 'tenantId'],
  container_registry: ['url'],
  fc_switch: ['wwnn', 'serialNumber'],
  fc_fabric: ['fabricWwn'],
  fc_zone: ['fabricRef', 'name'],
  nas_share: ['arrayRef', 'protocol', 'path'],
  object_bucket: ['endpoint', 'name'],
  database_cluster: ['engine', 'clusterId'],
  unknown: ['address', 'primaryMac'],
  container: ['containerId'],
  k8s_cluster: ['clusterUid'],
  k8s_namespace: ['clusterUid', 'name'],
  k8s_workload: ['uid'],
  k8s_service: ['uid'],
  network_device: ['serialNumber', 'chassisId', 'sysName'],
  interface: ['deviceRef', 'ifIndex', 'name'],
  port: ['deviceRef', 'name'],
  vlan: ['deviceRef', 'vlanId'],
  vrf: ['deviceRef', 'name'],
  ip_address: ['address', 'vrfRef'],
  subnet: ['cidr', 'vrfRef'],
  dns_zone: ['name'],
  dns_record: ['zoneRef', 'name', 'recordType', 'value'],
  dhcp_scope: ['serverRef', 'cidr'],
  dhcp_lease: ['scopeRef', 'address'],
  load_balancer: ['serialNumber', 'managementIp'],
  firewall_rule: ['deviceRef', 'ruleId'],
  site_link: ['circuitId', 'fromSiteRef', 'toSiteRef'],
  storage_array: ['serialNumber'],
  lun: ['arrayRef', 'wwn'],
  database: ['hostRef', 'engine', 'name', 'port'],
  certificate: ['fingerprintSha256'],
  application: ['name'],
  application_component: ['applicationRef', 'name'],
  listening_service: ['hostRef', 'protocol', 'port'],
  business_service: ['name'],
  software: ['vendor', 'name', 'version'],
  software_instance: ['hostRef', 'softwareRef', 'installPath'],
  licence: ['licenceKeyDigest', 'softwareRef'],
  vulnerability: ['cveId'],
  site: ['code'],
  building: ['siteRef', 'name'],
  room: ['buildingRef', 'name'],
  row: ['roomRef', 'name'],
  rack: ['roomRef', 'name'],
  pdu: ['serialNumber'],
  power_feed: ['pduRef', 'name'],
  power_circuit: ['siteRef', 'name'],
  ups: ['serialNumber'],
  cooling_unit: ['serialNumber'],
  cable: ['label', 'endpointA', 'endpointB'],
  patch_panel: ['rackRef', 'name'],
  cloud_account: ['provider', 'accountId'],
  cloud_resource: ['provider', 'resourceId'],
  user_account: ['directoryRef', 'principalName'],
  service_account: ['directoryRef', 'principalName'],
  vendor: ['name'],
  contract: ['vendorRef', 'contractNumber'],
  cost_centre: ['code'],
};

/** A CI as observed by a collector: identity-addressed, not yet reconciled to a stored id. */
export const observedCiSchema = z.object({
  type: ciTypeSchema,
  /** Values for the type's CI_IDENTITY_KEYS; at least one key must be present. */
  identity: z.record(z.string().min(1), z.string().min(1)).refine((r) => Object.keys(r).length > 0, {
    message: 'identity must contain at least one key',
  }),
  name: z.string().min(1),
  attributes: attributesSchema,
  tags: z.array(z.string().min(1)),
  externalIds: z.array(externalIdSchema),
  observedAt: z.iso.datetime(),
});
export type ObservedCi = z.infer<typeof observedCiSchema>;

/** A stored, reconciled CI. validTo is null while current; time-travel reads by [validFrom, validTo). */
export const ciSchema = observedCiSchema.extend({
  id: z.uuid(),
  tenantId: z.uuid(),
  displayName: z.string().min(1),
  /** Short code shown on cards and spoken in incidents, e.g. NET-ARISTA-SPINE1; generated by ciCode() and editable. */
  code: z.string().regex(/^[A-Z0-9]+-[A-Z0-9-]+$/),
  /** Effective layer: userLabel.layer when present, else CI_TYPE_LAYER[type]. */
  layer: ciLayerSchema,
  userLabel: userLabelSchema.nullable(),
  lifecycle: lifecycleSchema,
  source: provenanceSchema,
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime().nullable(),
  /** SHA-256 of canonical (type, identity, attributes) used to detect change without diffing. */
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
});
export type Ci = z.infer<typeof ciSchema>;

/** Reference to a CI by identity (from collectors) or by id (from stores). */
export const ciRefSchema = z.union([
  z.object({ id: z.uuid() }),
  z.object({ type: ciTypeSchema, identity: z.record(z.string().min(1), z.string().min(1)) }),
]);
export type CiRef = z.infer<typeof ciRefSchema>;

export const observedRelationshipSchema = z.object({
  type: relationshipTypeSchema,
  from: ciRefSchema,
  to: ciRefSchema,
  attributes: attributesSchema,
  observedAt: z.iso.datetime(),
});
export type ObservedRelationship = z.infer<typeof observedRelationshipSchema>;

export const relationshipSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  type: relationshipTypeSchema,
  fromCiId: z.uuid(),
  toCiId: z.uuid(),
  attributes: attributesSchema,
  source: provenanceSchema,
  observedAt: z.iso.datetime(),
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime().nullable(),
});
export type Relationship = z.infer<typeof relationshipSchema>;
