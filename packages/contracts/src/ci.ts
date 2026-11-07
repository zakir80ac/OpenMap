// REQ-CORE-001 — Configuration Item (CI) contract, version CONTRACT_VERSIONS.ci.
// Every store (Postgres, Memgraph, ClickHouse, Meilisearch) and every collector speaks this shape.
import { z } from 'zod';
import { componentSchema } from './component.js';

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

/**
 * The one metric every card and table shows for a CI of a layer (ADR-016). `key` names the headline in the
 * console's i18n catalogue (`metric.<key>`), `label` is its canonical English label, `unit` is printed after the
 * value, and `metric` is the ClickHouse `metrics.metric` name whose latest sample supplies the value
 * (packages/db/clickhouse/README.md). `lastSeenDays` has no sample: the API derives it from `observedAt`.
 */
export interface HeadlineMetricSpec {
  key: string;
  label: string;
  unit: string;
  metric: string;
}

export const LAYER_HEADLINE_METRIC = {
  dc: { key: 'pue', label: 'PUE', unit: '', metric: 'dcim.site.pue' },
  network_security: { key: 'throughputGbps', label: 'Traffic', unit: 'Gbps', metric: 'net.device.throughput_gbps' },
  hardware: { key: 'cpuPercent', label: 'Host load', unit: '%', metric: 'host.cpu.utilisation_percent' },
  storage: { key: 'iops', label: 'IOPS', unit: '', metric: 'storage.array.iops' },
  virtualization: { key: 'cpuPercent', label: 'CPU', unit: '%', metric: 'vm.cpu.utilisation_percent' },
  cloud: { key: 'loadPercent', label: 'Load', unit: '%', metric: 'cloud.resource.load_percent' },
  os: { key: 'patchCompliancePercent', label: 'Patched', unit: '%', metric: 'os.patch.compliance_percent' },
  containers: { key: 'cpuPercent', label: 'CPU', unit: '%', metric: 'container.cpu.utilisation_percent' },
  databases: { key: 'iops', label: 'IOPS', unit: '', metric: 'db.instance.iops' },
  applications: { key: 'apdex', label: 'Apdex', unit: '', metric: 'app.apdex.score' },
  saas: { key: 'seatUtilisationPercent', label: 'Seats used', unit: '%', metric: 'saas.seat.utilisation_percent' },
  unknown: { key: 'lastSeenDays', label: 'Last seen', unit: 'd', metric: 'discovery.last_seen.days' },
} as const satisfies Record<CiLayer, HeadlineMetricSpec>;

/** The headline keys the console must label: `metric.<HeadlineMetricKey>` exists in every catalogue. */
export type HeadlineMetricKey = (typeof LAYER_HEADLINE_METRIC)[CiLayer]['key'];

/** Metric names a headline reads, in layer order and without repeats; the API asks ClickHouse for exactly these. */
export const HEADLINE_METRIC_NAMES: readonly string[] = [...new Set(CI_LAYERS.map((layer) => LAYER_HEADLINE_METRIC[layer].metric))];

/** `<domain>.<object>.<measure>[_<unit>]`, the ClickHouse metric name convention. */
export const METRIC_NAME_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*){2,}$/u;

/** Generates a CI short code: layer prefix plus an upper-case slug of the name, capped for display. */
/** Shape of a short code: a layer prefix, a dash, then the slug (and an optional numeric uniqueness suffix). */
export const CI_CODE_PATTERN = /^[A-Z0-9]+-[A-Z0-9-]+$/u;

export function ciCode(layer: CiLayer, type: CiType, name: string, maxSlugLength = 24): string {
  const prefix = type === 'business_service' ? BUSINESS_SERVICE_CODE_PREFIX : LAYER_CODE_PREFIX[layer];
  const slug = name
    .toUpperCase()
    // A dotted tail is dropped only when it is a domain suffix (has a letter); 10.0.0.1 keeps all of its octets.
    .replace(/\.(?=[A-Z0-9.-]*[A-Z])[A-Z0-9.-]*$/u, '')
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

/** Health of a CI as stored on every node and exposed by the GraphQL `HealthState` enum. */
export const HEALTH_STATES = ['healthy', 'degraded', 'down', 'unknown'] as const;
export const healthStateSchema = z.enum(HEALTH_STATES);
export type HealthState = z.infer<typeof healthStateSchema>;

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
  'serialNumber',
  'systemUuid',
  'fqdn',
  'primaryMac',
  'instanceUuid',
  'chassisId',
  'clusterUid',
  'uid',
  'containerId',
  'managementIp',
  'wwn',
  'wwnn',
  'fabricWwn',
  'fingerprintSha256',
  'cveId',
  'licenceKeyDigest',
  'resourceId',
  'url',
  'principalName',
  'contractNumber',
  'circuitId',
  'address',
  'cidr',
  'moRef',
  'clusterId',
  'accountId',
  'tenantId',
]);

/**
 * ADR-045: globally unique keys that are unique only within their issuer. A SaaS tenant id is issued per vendor, an
 * account or resource id per cloud provider, a cluster id per platform or database engine, a moRef per platform and a
 * contract number per vendor. Such a key matches on its own only together with the scope keys the CI type declares,
 * all present and equal; an observation missing one of them is matched by its full tuple only.
 */
export const GLOBAL_IDENTITY_SCOPES: Readonly<Record<string, readonly string[]>> = {
  tenantId: ['vendor'],
  accountId: ['provider'],
  resourceId: ['provider'],
  clusterId: ['platform', 'engine'],
  moRef: ['platform'],
  contractNumber: ['vendorRef'],
};

/**
 * ADR-045: globally unique keys that, in these types, name the CI's parent rather than the CI: every namespace of a
 * cluster carries the cluster's UID. They identify such a CI only together with the rest of its tuple.
 */
export const PARENT_IDENTITY_KEYS: Readonly<Partial<Record<CiType, readonly string[]>>> = {
  k8s_namespace: ['clusterUid'],
};

/**
 * ADR-045: the CI types each `*Ref` identity key can name. Observers name one CI differently (a load balancer names a
 * pool member by its IP or FQDN, the host's own collector by its serial), so reconciliation resolves a ref value to the
 * referenced CI's id before it compares tuples. A key with no target types names something that is not a CI on its own
 * (a VRF name is only unique within its device, a directory is not a CI type) and is compared as written.
 */
export const IDENTITY_REF_TARGETS: Readonly<Record<string, readonly CiType[]>> = {
  chassisRef: ['chassis'],
  hostRef: ['host', 'vm'],
  hypervisorRef: ['hypervisor'],
  tenantRef: ['saas_tenant'],
  fabricRef: ['fc_fabric'],
  arrayRef: ['storage_array'],
  deviceRef: ['network_device', 'load_balancer', 'host', 'vm'],
  vrfRef: [],
  zoneRef: ['dns_zone'],
  serverRef: ['host', 'vm', 'network_device'],
  scopeRef: ['dhcp_scope'],
  fromSiteRef: ['site'],
  toSiteRef: ['site'],
  siteRef: ['site'],
  buildingRef: ['building'],
  roomRef: ['room'],
  rackRef: ['rack'],
  pduRef: ['pdu'],
  applicationRef: ['application'],
  softwareRef: ['software'],
  directoryRef: [],
  vendorRef: ['vendor'],
};

/**
 * ADR-045: attributes whose values also name the CI to a `*Ref` (the name a load balancer or DNS gives it, the address a
 * scanner dialled). They rank below identity values: a ref that matches one CI by identity and another by attribute
 * names the first.
 */
export const IDENTITY_REF_ALIAS_ATTRIBUTES: readonly string[] = ['fqdn', 'hostname', 'primaryIp', 'ipAddress', 'managementIp'];

/**
 * ADR-045: ref spellings collectors derive from identity values: SNMP's `serial:<serial>` for a device, and the
 * `name@version` that SSH, WMI and the agent write for installed software.
 */
export const IDENTITY_REF_DERIVED: ReadonlyArray<{ readonly keys: readonly string[]; readonly prefix: string; readonly separator: string }> = [
  { keys: ['serialNumber'], prefix: 'serial:', separator: '' },
  { keys: ['name', 'version'], prefix: '', separator: '@' },
];

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
  /** REQ-CMDB-014 (ADR-037): the full part list when the collector sees parts; absent leaves stored parts alone. */
  components: z.array(componentSchema).optional(),
});
export type ObservedCi = z.infer<typeof observedCiSchema>;

/** A stored, reconciled CI. validTo is null while current; time-travel reads by [validFrom, validTo). */
export const ciSchema = observedCiSchema.extend({
  id: z.uuid(),
  tenantId: z.uuid(),
  displayName: z.string().min(1),
  /** Short code shown on cards and spoken in incidents, e.g. NET-ARISTA-SPINE1; generated by ciCode() and editable. */
  code: z.string().regex(CI_CODE_PATTERN),
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

/**
 * One measurement a collector took on a CI it observed (ADR-016). The CI is referenced the way relationships
 * reference endpoints (by identity, or by id when the collector was given one); the reconciler resolves it and
 * drops samples whose CI it cannot find. `labels` carries dimensions (rack_id, cidr, interface).
 */
export const metricSampleSchema = z.object({
  ci: ciRefSchema,
  metric: z.string().regex(METRIC_NAME_PATTERN),
  ts: z.iso.datetime(),
  value: z.number().finite(),
  unit: z.string(),
  labels: z.record(z.string().min(1), z.string()),
});
export type MetricSample = z.infer<typeof metricSampleSchema>;

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
