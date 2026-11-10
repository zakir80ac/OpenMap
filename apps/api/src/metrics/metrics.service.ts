// REQ-CORE-012 — Prometheus registry: Node default metrics plus the GraphQL request counter and
// duration histogram. Bucket edges derive from the performance budgets so alerts align with them.
import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { IMPACT, IPV4, PERF_BUDGETS, TIME } from '@openmap/constants';

export const GRAPHQL_REQUESTS_METRIC = 'openmap_graphql_requests_total';
export const GRAPHQL_DURATION_METRIC = 'openmap_graphql_duration_seconds';
/** REQ-SEC-005 — audit entries written, by mutation name. */
export const AUDIT_ENTRIES_METRIC = 'openmap_audit_entries_total';
/** REQ-UI-017 — Superset guest tokens minted for embedded analytics. */
export const ANALYTICS_TOKENS_METRIC = 'openmap_analytics_guest_tokens_total';
/** REQ-CMDB-038 — ClickHouse read queries issued by the API, by query name and outcome. */
export const CLICKHOUSE_QUERIES_METRIC = 'openmap_clickhouse_queries_total';
/** REQ-AI-007 */
export const ASSISTANT_QUESTIONS_METRIC = 'openmap_assistant_questions_total';
export const ASSISTANT_DURATION_METRIC = 'openmap_assistant_duration_seconds';
/** REQ-DCIM-007 */
export const CAPACITY_METRIC = 'openmap_dcim_capacity_reads_total';
/** REQ-DEP-001 (ADR-030): network topology map duration, by layer. */
export const TOPOLOGY_DURATION_METRIC = 'openmap_topology_duration_seconds';
/** REQ-CMDB-033 (ADR-032): rows imported (queued or rejected) and exported, by outcome and format. */
export const IMPORT_ROWS_METRIC = 'openmap_import_rows_total';
export const EXPORT_ROWS_METRIC = 'openmap_export_rows_total';
/** REQ-INT-011 (ADR-072): inventory documents served to configuration-management tools, and the nodes in them, by tool. */
export const INVENTORY_EXPORTS_METRIC = 'openmap_inventory_exports_total';
export const INVENTORY_NODES_METRIC = 'openmap_inventory_nodes_total';
/** REQ-DEP-004 (ADR-031): layered application map duration. */
export const APPLICATION_MAP_DURATION_METRIC = 'openmap_application_map_duration_seconds';
/** REQ-BSM-004 (ADR-047): incidents compared with a simulation, by outcome, and the accuracy each one scored. */
export const IMPACT_VALIDATIONS_METRIC = 'openmap_impact_validations_total';
export const IMPACT_ACCURACY_METRIC = 'openmap_impact_prediction_accuracy';
/** REQ-BSM-005 (ADR-048): runbook steps run on incidents, by outcome (done, triggered, failed). */
export const RUNBOOK_STEPS_METRIC = 'openmap_runbook_steps_total';
/** REQ-UI-027: telemetry fleet snapshot builds, by outcome, and how long a build took. */
export const TELEMETRY_SNAPSHOT_METRIC = 'openmap_telemetry_snapshot_seconds';
/** REQ-AI-002: classification suggestions made, accepted and dismissed. */
export const CLASSIFICATION_METRIC = 'openmap_classification_suggestions_total';
/** REQ-AI-003: anomaly findings opened, cleared and explained, by rule. */
export const ANOMALY_METRIC = 'openmap_anomaly_findings_total';
/** REQ-AI-005: cloud recommendations computed, by kind. */
export const CLOUD_RECOMMENDATION_METRIC = 'openmap_cloud_recommendations_total';
/** REQ-IPAM-003: DNS record changes requested, by op. */
export const DNS_CHANGE_METRIC = 'openmap_dns_changes_total';
/** REQ-DCIM-001 (ADR-056): patch panels saved, cables connected and disconnected, circuits saved. */
export const CABLING_CHANGE_METRIC = 'openmap_cabling_changes_total';
/** REQ-DCIM-008 */
export const CABLING_VERIFICATION_METRIC = 'openmap_cabling_verifications_total';
/** REQ-IPAM-004 */
export const SWITCH_PORT_METRIC = 'openmap_switch_port_reads_total';
/** REQ-IPAM-005 */
export const FIREWALL_METRIC = 'openmap_firewall_reads_total';
/** REQ-INT-009 */
export const NOTIFICATION_TEST_METRIC = 'openmap_notification_tests_total';
/** REQ-SEC-011 (ADR-067 step 4): values sent through Transit, by op and outcome. */
export const FIELD_CIPHER_METRIC = 'openmap_field_cipher_values_total';
/** REQ-DCIM-003: racks moved on the floor plan. */
export const RACK_MOVE_METRIC = 'openmap_rack_moves_total';
/** REQ-DCIM-004: device cords recorded on and removed from PDU outlets. */
export const POWER_CONNECTION_METRIC = 'openmap_power_connections_total';
/** REQ-DCIM-005: power monitoring reads and threshold/tariff changes. */
export const POWER_MONITOR_METRIC = 'openmap_power_monitor_reads_total';
export const POWER_SETTINGS_METRIC = 'openmap_power_settings_changes_total';
/** REQ-DCIM-006: room environment reads. */
export const ENVIRONMENT_METRIC = 'openmap_environment_reads_total';
/** REQ-CORE-019 (ADR-049): REST v1 calls by route and status, and their duration. */
export const REST_REQUESTS_METRIC = 'openmap_rest_requests_total';
export const REST_DURATION_METRIC = 'openmap_rest_request_duration_seconds';

export type RequestStatus = 'ok' | 'error';

/**
 * Histogram edges in seconds: the screen-interaction budget halved twice below it, then doubling up
 * to four times the impact-query budget, so both p95 budgets fall exactly on a bucket boundary.
 */
export function durationBuckets(): number[] {
  const screen = PERF_BUDGETS.screenInteractionP95Ms / TIME.msPerSecond;
  const impact = PERF_BUDGETS.impactQuery100kP95Ms / TIME.msPerSecond;
  const ratio = IPV4.binaryBase;
  const edges = [screen / ratio / ratio, screen / ratio, screen];
  let edge = screen * ratio;
  while (edge < impact) {
    edges.push(edge);
    edge *= ratio;
  }
  edges.push(impact, impact * ratio, impact * ratio * ratio);
  return [...new Set(edges)].sort((a, b) => a - b);
}

@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly requests: Counter<'operation' | 'status'>;
  readonly duration: Histogram<'operation' | 'status'>;
  readonly auditEntries: Counter<'action'>;
  readonly analyticsTokens: Counter<string>;
  readonly clickhouseQueries: Counter<'query' | 'status'>;
  /** REQ-AI-007 — assistant questions by classified intent and outcome (answered, clarified, failed). */
  readonly assistantQuestions: Counter<'intent' | 'outcome'>;
  readonly assistantDuration: Histogram<'intent'>;
  readonly topologyDuration: Histogram<'layer'>;
  readonly applicationMapDuration: Histogram;
  readonly impactValidations: Counter<'outcome'>;
  readonly impactAccuracy: Histogram;
  readonly runbookSteps: Counter<'outcome'>;
  readonly telemetrySnapshot: Histogram<'outcome'>;
  readonly classifications: Counter<'outcome'>;
  readonly anomalies: Counter<'rule' | 'outcome'>;
  readonly cloudRecommendations: Counter<'kind'>;
  readonly dnsChanges: Counter<'op'>;
  readonly cablingChanges: Counter<'kind' | 'op'>;
  /** REQ-DCIM-008 — cable verification reads (recorded cables against observed adjacencies). */
  readonly cablingVerifications: Counter;
  /** REQ-IPAM-004 — switch port reads by query (ports, history, mac). */
  readonly switchPortReads: Counter<'query'>;
  /** REQ-IPAM-005 — firewall reads by query (devices, policy, check). */
  readonly firewallReads: Counter<'query'>;
  /** REQ-INT-009 — test notifications queued, by vendor. */
  readonly notificationTests: Counter<'vendor'>;
  /** REQ-SEC-011 — personal-data values encrypted or decrypted through OpenBao Transit. */
  readonly fieldCipher: Counter<'op' | 'outcome'>;
  readonly rackMoves: Counter;
  readonly powerConnections: Counter<'op'>;
  readonly powerMonitorReads: Counter;
  /** REQ-DCIM-007 — room capacity reads (space, power, cooling, ports, trend). */
  readonly capacityReads: Counter;
  readonly powerSettingsChanges: Counter;
  readonly environmentReads: Counter;
  readonly restRequests: Counter<'route' | 'status'>;
  readonly restDuration: Histogram<'route'>;
  readonly importRows: Counter<'outcome'>;
  readonly exportRows: Counter<'format'>;
  readonly inventoryExports: Counter<'tool'>;
  readonly inventoryNodes: Counter<'tool'>;

  constructor() {
    collectDefaultMetrics({ register: this.registry });
    this.requests = new Counter({
      name: GRAPHQL_REQUESTS_METRIC,
      help: 'GraphQL operations served, by operation name and outcome',
      labelNames: ['operation', 'status'],
      registers: [this.registry],
    });
    this.duration = new Histogram({
      name: GRAPHQL_DURATION_METRIC,
      help: 'GraphQL operation duration in seconds',
      labelNames: ['operation', 'status'],
      buckets: durationBuckets(),
      registers: [this.registry],
    });
    this.auditEntries = new Counter({
      name: AUDIT_ENTRIES_METRIC,
      help: 'Audit log entries written, by mutation',
      labelNames: ['action'],
      registers: [this.registry],
    });
    this.analyticsTokens = new Counter({
      name: ANALYTICS_TOKENS_METRIC,
      help: 'Superset guest tokens minted for embedded analytics',
      registers: [this.registry],
    });
    this.clickhouseQueries = new Counter({
      name: CLICKHOUSE_QUERIES_METRIC,
      help: 'ClickHouse read queries issued by the API, by query name and outcome',
      labelNames: ['query', 'status'],
      registers: [this.registry],
    });
    this.assistantQuestions = new Counter({
      name: ASSISTANT_QUESTIONS_METRIC,
      help: 'Assistant questions, by classified intent and outcome',
      labelNames: ['intent', 'outcome'],
      registers: [this.registry],
    });
    this.assistantDuration = new Histogram({
      name: ASSISTANT_DURATION_METRIC,
      help: 'Assistant answer duration in seconds, by intent',
      labelNames: ['intent'],
      buckets: durationBuckets(),
      registers: [this.registry],
    });
    this.topologyDuration = new Histogram({
      name: TOPOLOGY_DURATION_METRIC,
      help: 'Network topology map duration in seconds, by layer',
      labelNames: ['layer'],
      buckets: durationBuckets(),
      registers: [this.registry],
    });
    this.importRows = new Counter({
      name: IMPORT_ROWS_METRIC,
      help: 'Import rows, by outcome (queued or rejected)',
      labelNames: ['outcome'],
      registers: [this.registry],
    });
    this.exportRows = new Counter({
      name: EXPORT_ROWS_METRIC,
      help: 'CIs exported, by format',
      labelNames: ['format'],
      registers: [this.registry],
    });
    this.inventoryExports = new Counter({
      name: INVENTORY_EXPORTS_METRIC,
      help: 'Inventory documents served to configuration-management tools, by tool (ansible, salt, puppet, chef)',
      labelNames: ['tool'],
      registers: [this.registry],
    });
    this.inventoryNodes = new Counter({
      name: INVENTORY_NODES_METRIC,
      help: 'Nodes in the inventory documents served, by tool',
      labelNames: ['tool'],
      registers: [this.registry],
    });
    this.applicationMapDuration = new Histogram({
      name: APPLICATION_MAP_DURATION_METRIC,
      help: 'Layered application map duration in seconds',
      buckets: durationBuckets(),
      registers: [this.registry],
    });
    this.impactValidations = new Counter({
      name: IMPACT_VALIDATIONS_METRIC,
      help: 'Resolved incidents compared with a simulation of their root cause, by outcome (exact, partial, failed)',
      labelNames: ['outcome'],
      registers: [this.registry],
    });
    this.impactAccuracy = new Histogram({
      name: IMPACT_ACCURACY_METRIC,
      help: 'Jaccard accuracy of each validated impact prediction, 0..1',
      buckets: [...IMPACT.accuracyBuckets],
      registers: [this.registry],
    });
    this.restRequests = new Counter({
      name: REST_REQUESTS_METRIC,
      help: 'REST v1 calls, by route id and HTTP status',
      labelNames: ['route', 'status'],
      registers: [this.registry],
    });
    this.restDuration = new Histogram({
      name: REST_DURATION_METRIC,
      help: 'REST v1 call duration in seconds, by route id',
      labelNames: ['route'],
      buckets: durationBuckets(),
      registers: [this.registry],
    });
    this.runbookSteps = new Counter({
      name: RUNBOOK_STEPS_METRIC,
      help: 'Runbook steps run on incidents, by outcome (done, triggered, failed)',
      labelNames: ['outcome'],
      registers: [this.registry],
    });
    this.telemetrySnapshot = new Histogram({
      name: TELEMETRY_SNAPSHOT_METRIC,
      help: 'Telemetry fleet snapshot build duration in seconds, by outcome',
      labelNames: ['outcome'],
      buckets: durationBuckets(),
      registers: [this.registry],
    });
    this.classifications = new Counter({
      name: CLASSIFICATION_METRIC,
      help: 'Classification suggestions for unknown CIs, by outcome (suggested, accepted, dismissed)',
      labelNames: ['outcome'],
      registers: [this.registry],
    });
    this.anomalies = new Counter({
      name: ANOMALY_METRIC,
      help: 'Anomaly findings by rule and outcome (opened, cleared, explained, explain_failed)',
      labelNames: ['rule', 'outcome'],
      registers: [this.registry],
    });
    this.cloudRecommendations = new Counter({
      name: CLOUD_RECOMMENDATION_METRIC,
      help: 'Cloud recommendations computed, by kind (release_stopped, decommission_idle, downsize, upsize)',
      labelNames: ['kind'],
      registers: [this.registry],
    });
    this.dnsChanges = new Counter({
      name: DNS_CHANGE_METRIC,
      help: 'DNS record changes requested in OpenMap, by op (add, delete)',
      labelNames: ['op'],
      registers: [this.registry],
    });
    this.switchPortReads = new Counter({
      name: SWITCH_PORT_METRIC,
      help: "Switch port reads by query: a device's ports, a port's history, a MAC lookup",
      labelNames: ['query'],
      registers: [this.registry],
    });
    this.notificationTests = new Counter({
      name: NOTIFICATION_TEST_METRIC,
      help: 'Test notifications queued for the BSM engine to send, by vendor',
      labelNames: ['vendor'],
      registers: [this.registry],
    });
    this.fieldCipher = new Counter({
      name: FIELD_CIPHER_METRIC,
      help: 'Personal-data values sent through OpenBao Transit, by op (encrypt, decrypt) and outcome (ok, error)',
      labelNames: ['op', 'outcome'],
      registers: [this.registry],
    });
    this.firewallReads = new Counter({
      name: FIREWALL_METRIC,
      help: "Firewall reads by query: devices with rules, a device's policy and analysis, a traffic check",
      labelNames: ['query'],
      registers: [this.registry],
    });
    this.cablingVerifications = new Counter({
      name: CABLING_VERIFICATION_METRIC,
      help: 'Cable verification reads: recorded cables judged against observed adjacencies',
      registers: [this.registry],
    });
    this.cablingChanges = new Counter({
      name: CABLING_CHANGE_METRIC,
      help: 'Cabling changes by kind (patch_panel, cable, circuit) and op (saved, connected, disconnected)',
      labelNames: ['kind', 'op'],
      registers: [this.registry],
    });
    this.rackMoves = new Counter({
      name: RACK_MOVE_METRIC,
      help: 'Racks moved to a row slot on the floor plan',
      registers: [this.registry],
    });
    this.powerConnections = new Counter({
      name: POWER_CONNECTION_METRIC,
      help: 'Device cords on PDU outlets by op (connected, disconnected)',
      labelNames: ['op'],
      registers: [this.registry],
    });
    this.powerMonitorReads = new Counter({
      name: POWER_MONITOR_METRIC,
      help: 'Room power monitoring reads (series, energy and billing)',
      registers: [this.registry],
    });
    this.capacityReads = new Counter({
      name: CAPACITY_METRIC,
      help: 'Room capacity reads (space, power, cooling, ports and the power trend)',
      registers: [this.registry],
    });
    this.powerSettingsChanges = new Counter({
      name: POWER_SETTINGS_METRIC,
      help: 'Power threshold and tariff changes',
      registers: [this.registry],
    });
    this.environmentReads = new Counter({
      name: ENVIRONMENT_METRIC,
      help: 'Room environment reads (temperature, humidity, airflow)',
      registers: [this.registry],
    });
  }

  observe(operation: string, status: RequestStatus, seconds: number): void {
    this.requests.inc({ operation, status });
    this.duration.observe({ operation, status }, seconds);
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
