// REQ-CORE-004 — named constants with rationale. Every value here is one that is
// identical in every deployment; anything that may differ belongs in @openmap/config.

/** Workstream identifiers used in requirement IDs (CLAUDE.md §3). Order is display order. */
export const WORKSTREAMS = [
  'CORE',
  'DISC',
  'DEP',
  'CMDB',
  'IPAM',
  'DCIM',
  'BSM',
  'UI',
  'AI',
  'INT',
  'QA',
  'PERF',
  'SEC',
] as const;
export type Workstream = (typeof WORKSTREAMS)[number];

/** Human names for workstreams, used by the tracker Workstreams sheet. */
export const WORKSTREAM_NAMES: Record<Workstream, string> = {
  CORE: 'Core platform and contracts',
  DISC: 'Discovery and collectors',
  DEP: 'Application dependency mapping',
  CMDB: 'CMDB, software, licence, vulnerability correlation',
  IPAM: 'IPAM, DNS and DHCP',
  DCIM: 'DCIM: racks, power, cooling, cabling',
  BSM: 'Business service management',
  UI: 'Console UI, design system, i18n',
  AI: 'AI assistant over the graph',
  INT: 'Integrations and deployment profiles',
  QA: 'Quality: test harness, fixtures, synthetic estate',
  PERF: 'Performance budgets',
  SEC: 'Security and sovereignty controls',
};

/** Requirement lifecycle states (CLAUDE.md §3). Order is the lifecycle order. */
export const REQ_STATUSES = ['Not started', 'In progress', 'Blocked', 'In review', 'Done'] as const;
export type ReqStatus = (typeof REQ_STATUSES)[number];

/** Priorities; P0 is highest. Sorting the tracker uses the index. */
export const PRIORITIES = ['P0', 'P1', 'P2'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Test types recorded on the Tests sheet. */
export const TEST_TYPES = ['unit', 'integration', 'e2e', 'perf', 'security'] as const;
export type TestType = (typeof TEST_TYPES)[number];

/** ID formats. Three digits: the spec expects 250–400 rows in total, far fewer per workstream. */
export const REQ_ID_PATTERN = /^REQ-(CORE|DISC|DEP|CMDB|IPAM|DCIM|BSM|UI|AI|INT|QA|PERF|SEC)-(\d{3})$/;
export const TEST_ID_PATTERN = /^T-(\d{3,})$/;
export const ADR_ID_PATTERN = /^ADR-(\d{3})$/;
export const ID_PAD_WIDTH = 3;

/** Tracker workbook sheet names (CLAUDE.md §3). */
export const TRACKER_SHEETS = {
  requirements: 'Requirements',
  workstreams: 'Workstreams',
  components: 'Components',
  contracts: 'Contracts',
  decisions: 'Decisions',
  risks: 'Risks',
  tests: 'Tests',
  sessions: 'Sessions',
  dashboard: 'Dashboard',
} as const;

/** Repository-relative paths that are part of the fixed layout (CLAUDE.md §5). */
export const REPO_PATHS = {
  tracker: 'tracker/OpenMap-Tracker.xlsx',
  trackerSummary: 'docs/TRACKER-SUMMARY.md',
  spec: 'docs/SPEC.md',
  state: 'docs/STATE.md',
  contracts: 'docs/CONTRACTS.md',
  adrDir: 'docs/adr',
  graphReport: 'graphify-out/GRAPH_REPORT.md',
} as const;

/**
 * Performance budgets from CLAUDE.md §0. These are product requirements, not tuning
 * targets, so they are constants rather than config: a deployment that relaxed them
 * would no longer be OpenMap.
 */
export const PERF_BUDGETS = {
  /** p95 latency for any console screen interaction. */
  screenInteractionP95Ms: 100,
  /** p95 latency for an impact query over a 100k-node graph. */
  impactQuery100kP95Ms: 1000,
  /** Node count the impact-query budget is measured against. */
  impactQueryGraphNodes: 100_000,
  /** Minimum sustained frame rate for graph rendering. */
  graphRenderFps: 60,
  /** Devices discovered per sweep within the discovery budget. */
  discoverySweepDevices: 10_000,
  /** Wall-clock budget for one discovery sweep of discoverySweepDevices. */
  discoverySweepMinutes: 15,
  /**
   * Lighthouse category floors (0–1) for the console's signed-in screens, CLAUDE.md §7. docs/SPEC.md has not
   * supplied its own targets yet (risk R-001), so these are the floors the console is held to until it does.
   */
  lighthousePerformanceMin: 0.9,
  lighthouseAccessibilityMin: 0.95,
  lighthouseBestPracticesMin: 0.95,
  /**
   * Screens that host a third-party application inside the page (the embedded Superset dashboard). Their shell is
   * held to the same accessibility and best-practice floors, but the performance floor is lower: the blocking time
   * Lighthouse measures there is Superset's own bundle executing, which on a same-site dev stack shares the
   * renderer with the console. REQ-UI-017 keeps the console's own paint under the budget (FCP and LCP well under
   * a second); the embedded application's cost is reported, not hidden.
   */
  lighthouseEmbeddedScreens: ['analytics'] as const,
  /**
   * ADR-026: a fully loaded embedded Superset dashboard costs about 1.5 s of script on Lighthouse's 4x-throttled CPU
   * (2.7 MB over 64 requests, its own vendors and embedded bundles), which scores 0.67 however fast the console paints
   * around it; the 0.70 set in ADR-012 was measured while the frame was still loading. The floor states that cost.
   */
  lighthouseEmbeddedPerformanceMin: 0.65,
  /** REQ-BSM-008: p95 for the yearly availability roll-up of availabilityReportServices business services. */
  availabilityReportP95Ms: 1000,
  availabilityReportServices: 300,
} as const;

/**
 * REQ-PERF-005 (ADR-071) — health and performance of the platform itself. The service level indicators the Platform
 * health screen shows and the Prometheus alert rules fire on are one catalogue (packages/telemetry `slo.ts`); these are
 * its objectives. The latency objective is the screen-interaction budget itself, so a live breach and a CI budget miss
 * mean the same thing. Everything here is identical in every deployment; where Prometheus is comes from PROMETHEUS_URL.
 */
export const PLATFORM_HEALTH = {
  /** Windows (minutes) the screen and `platformHealth(windowMinutes)` accept. The first is the default and the alert rules' rate window. */
  windowsMinutes: [5, 60, 1440] as const,
  /** The latency quantile every p95 indicator reads. */
  quantile: 0.95,
  /** Highest share of GraphQL operations, and of a service's HTTP requests, that may fail (1 %). */
  errorRatioMax: 0.01,
  /**
   * Oldest undelivered outbox row. The dispatcher idles RECONCILER.outboxIdleMs between empty claims and delivers a
   * batch in well under a second, so a minute means projections (graph, search, ClickHouse) are falling behind.
   */
  outboxAgeMaxSeconds: 60,
  /**
   * Jobs waiting in one BullMQ queue. A sweep queues results in bursts the reconciler clears within minutes; a queue
   * this deep for the whole alert window means the reconciler (or the BSM engine on the event stream) is not keeping up.
   */
  queueWaitingMax: 5_000,
  /** Event-loop delay (p99) of any Node service; past this every request on it waits. */
  eventLoopLagP99MaxSeconds: 0.2,
  /** How long a condition holds before its alert fires: a lost target or store quickly, a budget only when sustained. */
  alertForMinutes: { availability: 2, budget: 10 },
  /** One Prometheus HTTP API call from the API. */
  prometheusTimeoutMs: 5_000,
  /** A store probe at scrape time (reconciler): short, so a hung store marks itself down instead of stalling /metrics. */
  storeProbeTimeoutMs: 2_000,
  /** Scrape jobs in deploy/compose/prometheus/prometheus.yml. */
  jobs: { services: 'openmap-services', clickhouse: 'clickhouse', openbao: 'openbao', collector: 'otel-collector' },
  /** The OpenMap services the screen expects to find, as compose service names (the scrape target's host). */
  services: ['api', 'reconciler', 'scheduler', 'bsm-engine'] as const,
  /** OpenTelemetry service names are `openmap-<service>` (each app's instrumentation.ts). */
  otelServicePrefix: 'openmap-',
  /** Stores the reconciler probes at scrape time, plus OpenBao read from its own telemetry. */
  probedStores: ['postgres', 'memgraph', 'clickhouse', 'valkey', 'meilisearch'] as const,
  stores: ['postgres', 'memgraph', 'clickhouse', 'valkey', 'meilisearch', 'openbao'] as const,
  /** BullMQ job states counted per queue. */
  queueStates: ['waiting', 'active', 'delayed', 'failed'] as const,
  /** Metric names the reconciler serves at scrape time. */
  metrics: {
    storeUp: 'openmap_store_up',
    storeProbeSeconds: 'openmap_store_probe_seconds',
    outboxPending: 'openmap_outbox_pending_events',
    outboxOldest: 'openmap_outbox_oldest_pending_age_seconds',
    queueJobs: 'openmap_queue_jobs',
    reads: 'openmap_platform_health_reads_total',
  },
  /** Alert rule group name and the label every OpenMap SLO rule carries (the API keeps only alerts with it). */
  ruleGroup: 'openmap-slo',
  sliLabel: 'openmap_sli',
  /** At most this many firing or pending alerts are returned. */
  alertsLimit: 50,
  /** The screen refreshes on Prometheus's scrape interval (deploy/compose/prometheus/prometheus.yml): sooner shows nothing new. */
  refreshMs: 15_000,
  /** Display scales: ratios as percentages, resident memory in mebibytes. */
  percentScale: 100,
  bytesPerMebibyte: 1_048_576,
} as const;
export type PlatformWindowMinutes = (typeof PLATFORM_HEALTH.windowsMinutes)[number];
export type PlatformService = (typeof PLATFORM_HEALTH.services)[number];
export type PlatformStore = (typeof PLATFORM_HEALTH.stores)[number];
export type PlatformQueueState = (typeof PLATFORM_HEALTH.queueStates)[number];

/**
 * Graph query limits. Depth 6 covers DC → hardware → hypervisor → VM → application → service with one
 * spare hop; 12 is the hard ceiling that keeps the 100k-node impact query inside its budget.
 */
export const GRAPH = {
  defaultImpactDepth: 6,
  maxImpactDepth: 12,
  defaultPageSize: 50,
  maxPageSize: 500,
  /** Nodes detached and deleted per transaction when a tenant is purged from the graph. */
  purgeBatchSize: 5_000,
  /**
   * REQ-CORE-020 — attempts and the pause between them for a schema statement that meets a transient error. Memgraph
   * creates an index only with the storage to itself ("Cannot get unique access to the storage"), so a replay that
   * starts while the API or BSM engine is reading fails at its first statement; auto-commit statements get no driver
   * retry. A minute in all: on a CI runner, right after an estate replay, the storage stayed taken for over 10 s.
   */
  schemaRetryAttempts: 60,
  schemaRetryDelayMs: 1_000,
  /**
   * Relationship types that carry failure from a dependency to its dependants (traversed upstream). `contains` is
   * traversed only from the containers in `impactContainerTypes`: an application is down when its component is, a
   * switch is not down when one of its interfaces is (ADR-019).
   */
  impactEdgeTypes: [
    'depends_on',
    'runs_on',
    'hosted_on',
    'powered_by',
    'cooled_by',
    'connected_to',
    'cabled_to',
    'uses_ip',
    'mounted_on',
    'backed_by',
    'secured_by',
    'part_of_service',
    'contains',
  ] as const,
  /** CI types whose `contains` edge is a dependency on the member: logical containers made of their parts. */
  impactContainerTypes: ['application', 'k8s_namespace', 'k8s_cluster'] as const,
} as const;

/**
 * Reconciliation precedence. Discovery observations outrank imported seeds; a user label outranks
 * everything. Equal confidence is broken by the newer observation.
 */
export const RECONCILIATION = {
  discoveryDefaultConfidence: 0.9,
  importSeedConfidence: 0.6,
  userLabelConfidence: 1,
  /** Below this a source cannot overwrite an existing attribute, only fill a missing one. */
  overwriteMinConfidence: 0.5,
} as const;

/**
 * Business service management rules. A redundancy group is down when healthy members fall below
 * its minimum, degraded when it has no spare member left. Degraded services are assumed to lose
 * this fraction of revenue per hour in impact totals.
 */
/**
 * REQ-BSM-006 REQ-BSM-008 (ADR-024) — service level agreements: availability windows, response and resolution
 * targets by severity, the burn-rate alert, and the periods the uptime report shows.
 */
export const SLA = {
  /** Windows an SLA's availability target is measured over. */
  windows: ['calendar_month', 'calendar_quarter', 'calendar_year', 'rolling_30d'] as const,
  /** Granularities of the uptime report. */
  granularities: ['month', 'quarter', 'year'] as const,
  /** Periods the report shows by default, per granularity, and the most a request may ask for. */
  defaultPeriods: { month: 12, quarter: 8, year: 3 } as const,
  maxPeriods: 36,
  monthsPerQuarter: 3,
  monthsPerYear: 12,
  /** Rolling window length in days for the rolling_30d SLA window. */
  rollingWindowDays: 30,
  /**
   * Response (time to acknowledge) and resolution targets in minutes by incident severity, used when an SLA names none
   * of its own: the common 15/30/60-minute response ladder of a tier-1 operations team.
   */
  defaultTargets: {
    critical: { respondMinutes: 15, resolveMinutes: 240 },
    high: { respondMinutes: 30, resolveMinutes: 480 },
    medium: { respondMinutes: 60, resolveMinutes: 1440 },
    low: { respondMinutes: 240, resolveMinutes: 4320 },
    informational: { respondMinutes: 1440, resolveMinutes: 10080 },
  } as const,
  /** Burn rate (budget consumed per elapsed window fraction) at which an at-risk alert is raised; 1 exhausts exactly at window end. */
  defaultBurnRateAlert: 2,
  /** Availability target bounds a person may enter, in percent. */
  minTargetPercent: 50,
  maxTargetPercent: 100,
  /** Longest response or resolution target a person may enter, in minutes (30 days). */
  maxTargetMinutes: 43200,
  /** Numeric weight of each health state written to service_health_history.score. */
  healthScore: { healthy: 1, degraded: 0.5, unknown: 0, down: 0 } as const,
  /** Decimal places of availability percentages in reports and CSV. */
  percentDecimals: 3,
  /** Rows of the contributing-factors and corrective-actions editors. */
  rcaRows: 3,
  /** How far back the synthetic health history runs, in months, and the outage rates it draws from. */
  synthetic: {
    months: 14,
    outagesPerServiceMonthMax: 2,
    outageMinutesMin: 3,
    outageMinutesMax: 180,
    degradedShare: 0.4,
    tier1OutageFactor: 0.4,
    acknowledgeShare: 0.5,
    eventsPerOutage: 2,
    /** REQ-BSM-004 (ADR-047): CI types a replayed incident may name as its root cause, the failure points of an app. */
    rootCauseTypes: ['application_component', 'database_cluster', 'vm', 'host', 'hypervisor'],
    /** The pick reads this many hex digits of a SHA-256 (32 bits, well inside a safe integer) as base 16. */
    rootCausePickHexDigits: 8,
    rootCausePickRadix: 16,
  } as const,
} as const;
export type SlaWindow = (typeof SLA.windows)[number];
export type AvailabilityGranularity = (typeof SLA.granularities)[number];

export const BSM = {
  /**
   * REQ-PERF-002: a set of services' redundancy models (their members and groups) is reused for this long. Impact and
   * what-if queries over the same services in a burst then skip re-reading thousands of member rows; a group edit
   * shows within this window.
   */
  modelCacheMs: 30_000,
  modelCacheEntries: 64,
  slaPeriodDays: 30,
  degradedRevenueFactor: 0.3,
  minutesPerDay: 1440,
  msPerMinute: 60_000,
  percentScale: 100,
  /** Health states ordered from best to worst; index is severity rank. */
  healthOrder: ['healthy', 'unknown', 'degraded', 'down'] as const,
  /** A certificate this close to expiry marks its listener degraded. */
  certificateWarnDays: 30,
  /** A liveness-bearing CI not observed for this long is unknown, not healthy. */
  staleAfterMinutes: 180,
  /** Service recomputation waits this long after the last CI change so one sweep recomputes once. */
  recomputeDebounceMs: 2_000,
  /** Periodic recomputation (stale detection) interval for every known tenant. */
  tickMs: 60_000,
  /** Kubernetes workloads with fewer ready than desired replicas are degraded; none ready is down. */
  workloadHealthyRatio: 1,
  /** Predicted impact states ordered from worst to best for result sorting. */
  predictedOrder: ['down', 'degraded', 'at_risk', 'unaffected'] as const,
} as const;

/**
 * Discovery planning defaults. Concurrency and rate limits are per job; a sweep is split into chunks
 * so that the 15-minute budget for 10k devices holds with the default Node concurrency.
 */
export const DISCOVERY = {
  defaultConcurrency: 32,
  defaultRequestsPerSecond: 200,
  defaultJobTimeoutMs: 600_000,
  /** Targets per job; keeps result payloads small and lets failed chunks retry independently. */
  targetsPerJob: 256,
  /** Hosts addressable in a /24; used to expand CIDR targets without allocating per address. */
  maxCidrExpansion: 65_536,
  /** Retry schedule in milliseconds for retryable collector errors. */
  retryBackoffMs: [30_000, 120_000, 600_000] as const,
} as const;

/** IPv4 arithmetic facts, named so apps carry no numeric literals. */
export const IPV4 = {
  octets: 4,
  bitsPerOctet: 8,
  octetMax: 255,
  binaryBase: 2,
  /** Blocks larger than this skip network and broadcast addresses when enumerating hosts. */
  minSizeWithReservedEnds: 2,
} as const;

export const TIME = {
  secondsPerMinute: 60,
  msPerSecond: 1000,
  hoursPerDay: 24,
  msPerHour: 3_600_000,
  msPerDay: 86_400_000,
  microsecondsPerMillisecond: 1000,
  /** Length of a calendar date in ISO form (YYYY-MM-DD). */
  isoDateLength: 10,
} as const;

/** Node PKI parameters shared by the scheduler (issuer) and tests. */
export const PKI = {
  /** Random serial length in bytes; 16 satisfies RFC 5280's 20-octet maximum with margin. */
  serialBytes: 16,
  /** Random bytes in a one-time Node enrolment token (hex-encoded when shown). */
  enrolTokenBytes: 32,
  curve: 'P-256',
  hash: 'SHA-256',
  /** Hex characters in a SHA-256 digest, the form certificate fingerprints and evidence digests are stored in. */
  sha256HexLength: 64,
  /** Internal CA lifetime (ten years) and scheduler server certificate lifetime (browser-safe 825 days). */
  caValidityDays: 3650,
  serverValidityDays: 825,
} as const;

/**
 * Environment the Discovery Node binary reads (apps/node/internal/config/config.go, kept in step by hand): the setup
 * wizard prints the enrol command from these so an operator can paste it on the site's host (REQ-UI-024, ADR-017).
 */
export const DISCOVERY_NODE_ENV = {
  binary: 'openmap-node',
  enrolToken: 'OPENMAP_ENROL_TOKEN',
  schedulerUrl: 'OPENMAP_SCHEDULER_URL',
  nodeId: 'OPENMAP_NODE_ID',
  siteCode: 'OPENMAP_SITE_CODE',
} as const;

/**
 * Input syntax of the initial setup (REQ-UI-024, ADR-017): a site code as siteSchema spells it, a Discovery Node id
 * (DNS-label-like, the common name of its certificate), an IPv4 CIDR and an ISO 3166-1 alpha-2 country code.
 */
export const SETUP_PATTERNS = {
  siteCode: /^[A-Z0-9][A-Z0-9-]{0,11}$/,
  nodeId: /^[a-z0-9][a-z0-9-]{1,62}$/,
  /** Runs of characters a tenant slug cannot carry; each run becomes one dash. */
  slugSeparator: /[^a-z0-9]+/gu,
  cidrV4: /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/,
  countryCode: /^[A-Z]{2}$/,
} as const;

/** Bounds of the setup inputs: Uptime Institute tiers, WGS 84 coordinates, ISO 3166-1 alpha-2 length. */
export const SETUP_LIMITS = {
  maxTier: 4,
  /** ADR-025: site criticality runs 1 (most critical) to this. */
  maxCriticality: 3,
  latitudeMax: 90,
  longitudeMax: 180,
  countryCodeLength: 2,
  /** Rows of a multi-line secret field (PEM, kubeconfig) in the credential form. */
  secretTextareaRows: 4,
} as const;

/** Credential reference syntax accepted by the secrets reader: path segments, no traversal. */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;

/** HTTP statuses used by services and adapters; the retryable set drives delivery back-off. */
export const HTTP = {
  retryableStatuses: [408, 425, 429, 500, 502, 503, 504] as const,
  status: {
    ok: 200,
    created: 201,
    accepted: 202,
    noContent: 204,
    badRequest: 400,
    unauthorized: 401,
    forbidden: 403,
    notFound: 404,
    serviceUnavailable: 503,
    conflict: 409,
    tooManyRequests: 429,
    internalError: 500,
  },
  /** Largest request body the scheduler accepts from a Node: a 10k-device result stays well below this. */
  maxNodeBodyBytes: 64 * 1024 * 1024,
} as const;

/** ITSM priority scale shared by every adapter: 1 is the most urgent. */
export const ITSM = {
  priorityHighest: 1,
  priorityHigh: 2,
  priorityMedium: 3,
  jiraPriorityNames: { 1: 'Highest', 2: 'High', 3: 'Medium' } as const,
} as const;

/**
 * REQ-BSM-005 (ADR-048) — runbook automation. The vendors' fixed API routes (identical for every deployment; the host
 * comes from the integration's endpoint): Ansible AWX launches a job template, Cortex XSOAR creates an incident that
 * runs the named playbook. XSOAR's incident severity scale (0 unknown, 0.5 informational, 1 low … 4 critical) keyed
 * by OpenMap's incident severity. The extra-vars prefix keeps OpenMap's variables apart from a template's own.
 */
export const RUNBOOKS = {
  awxLaunchPath: 'api/v2/job_templates/{action}/launch/',
  xsoarIncidentPath: 'incident',
  actionToken: '{action}',
  xsoarSeverity: { informational: 0.5, low: 1, medium: 2, high: 3, critical: 4 } as const,
  extraVarsPrefix: 'openmap_',
  maxSteps: 50,
  maxNoteLength: 2_000,
} as const;

/** Assistant limits: schema grounding is truncated to keep prompts inside small local models. */
/** Electrical unit conversions used by DCIM views (REQ-DCIM-001). */
export const POWER = {
  wattsPerKilowatt: 1_000,
  /** Default PDU input voltage when a collector reports amps without volts (single-phase data-centre feeds). */
  defaultInputVoltage: 230,
  /** Line-to-line factor of a balanced three-phase supply: P = √3 × V × I. */
  threePhaseFactor: Math.sqrt(3),
  threePhase: 3,
  /**
   * REQ-DCIM-004: the battery runtime below which a UPS is flagged. A generator start and transfer takes seconds;
   * five minutes covers several failed starts and still leaves time for an orderly shutdown if the generator never
   * comes. A tenant with a different design reads the finding against its own runbook.
   */
  minUpsRuntimeMinutes: 5,
  /**
   * REQ-DCIM-005: PDU and outlet ids bound into one ClickHouse read of power samples. Parameters travel in the HTTP
   * query string, capped per field at 128 KiB by default; at about 40 bytes a UUID, 2,000 ids stay well inside it.
   */
  monitorIdBatch: 2_000,
  /** REQ-DCIM-005: how often the BSM engine compares every PDU's latest draw with the tenant's critical line. */
  alertEvaluateMs: 60_000,
  /**
   * A reading older than this is not judged: three hourly discovery sweeps without a sample means the PDU is not being
   * read, which is a discovery problem, not a power one.
   */
  alertFreshMs: 10_800_000,
  incidentSource: 'power',
  incidentSeverity: 'high',
} as const;

/**
 * REQ-DCIM-006 (ADR-060) — the environmental envelope, from ASHRAE TC 9.9 class A1 (enterprise servers and storage):
 * the recommended inlet range 18–27 °C, the allowable 15–32 °C; relative humidity allowable 8–80 % with 60 % the
 * recommended upper limit (the recommended lower limit is a −9 °C dew point, which a single RH reading cannot judge,
 * so only the allowable floor is checked below). Inside the recommended range is normal, inside the allowable range a
 * warning, outside it critical.
 */
export const ENVIRONMENT = {
  recommendedC: { min: 18, max: 27 },
  allowableC: { min: 15, max: 32 },
  allowableRh: { min: 8, max: 80 },
  recommendedMaxRh: 60,
  /**
   * Temperature rise across a rack (outlet − inlet) above which its airflow is flagged: servers are designed for a rise
   * of roughly 10–20 °C at full load, so more than 20 °C means starved airflow or hot air recirculating to the inlet.
   */
  maxRackRiseC: 20,
  /** A rack sensor reading older than this is not judged (three hourly sweeps). */
  freshMs: 10_800_000,
  evaluateMs: 60_000,
  incidentSource: 'environment',
  incidentSeverity: 'high',
} as const;

/** Assets screen (REQ-UI-009): warranty and support horizons offered in the attention table, in days. */
/** Money as the contracts carry it: ISO 4217 codes; "XXX" is the standard's code for "no currency". */
export const MONEY = {
  currencyCodeLength: 3,
  noCurrency: 'XXX',
} as const;

/** REQ-CMDB-032 (ADR-036) — certificate expiry alerts and key policy. */
export const CERTIFICATES = {
  /** Days before notAfter at which an alert is raised, once each; an expired certificate raises one more (threshold 0). */
  alertThresholdsDays: [60, 30, 14, 7, 1] as const,
  /** How often the BSM engine looks for certificates that crossed a threshold. */
  checkEveryMs: 900_000,
  /** RSA keys shorter than this are weak (NIST SP 800-131A). */
  minRsaBits: 2048,
  /** Elliptic-curve keys shorter than this are weak. */
  minEcBits: 256,
  /** Signature algorithms whose hash is no longer collision resistant, matched as lower-case fragments. */
  weakSignatures: ['sha1', 'md5'] as const,
  /** Expiry horizons the certificate register offers, in days. */
  expiryHorizonsDays: [7, 30, 60, 90] as const,
} as const;

/**
 * REQ-SEC-012 (ADR-070) — compliance posture: the thresholds the automated control checks apply to the facts OpenMap
 * already holds, and how much of an evaluation is kept and returned. The control catalogue itself is data in
 * packages/contracts/src/compliance.ts.
 */
export const COMPLIANCE = {
  /** CVE severities that make a CI high risk (CVSS v3 qualitative ratings High 7.0–8.9 and Critical 9.0–10.0). */
  highRiskSeverities: ['high', 'critical'] as const,
  /** A CVE without a severity label is high risk from this CVSS base score (the lower bound of CVSS v3 High). */
  highRiskCvss: 7,
  /** TLS protocol versions oldest first, as the certificate collector reports them; anything unlisted is unknown. */
  tlsVersions: ['SSL 3.0', 'TLS 1.0', 'TLS 1.1', 'TLS 1.2', 'TLS 1.3'] as const,
  /** The oldest acceptable protocol (TLS 1.0 and 1.1 are deprecated by RFC 8996; PCI DSS 4.0 requires strong crypto). */
  minTlsVersion: 'TLS 1.2',
  /** Values of an object store's `encryption` attribute that mean no server-side encryption. */
  unencryptedValues: ['none', 'disabled', 'off', 'false', ''] as const,
  /** The NAS collector's option for an SMB share that requires SMB 3 encryption. */
  smbEncryptOption: 'encrypt',
  /** NFS export options that give privacy on the wire (Kerberos v5 with encryption). */
  nfsPrivacyOptions: ['sec=krb5p'] as const,
  /** A database whose last backup is older than this fails the backup check: a daily schedule with two hours of slack. */
  databaseBackupMaxAgeHours: 26,
  /** Results written per INSERT when an evaluation is stored. */
  insertBatch: 5_000,
  /** The transaction that stores an evaluation and its results (a 100k-CI estate writes a few hundred thousand rows). */
  persistTimeoutMs: 300_000,
  /** Evaluations kept per tenant; older ones and their results are removed when a new one is stored. */
  keepRuns: 10,
  /** Findings returned for one control by default, and the most a client may ask for. */
  findingsPageSize: 50,
  maxFindings: 500,
  /** The longest control identifier a client may ask for (catalogue ids are a few characters, such as `A.8.24`). */
  controlIdMaxLength: 32,
  /** Pass rates are 0..1; the console shows them as a percentage with this many decimals. */
  percentScale: 100,
  percentDecimals: 1,
  /** A framework at or above this pass rate is shown healthy; below `passRateAtRisk` it is shown down, between at risk. */
  passRateHealthy: 0.95,
  passRateAtRisk: 0.8,
} as const;

/** REQ-CMDB-014 (ADR-037) — the parts register: page sizes and how many model rows it summarises. */
export const COMPONENTS = {
  /** Parts per page of the estate-wide register (GraphQL default of `components(first)`). */
  pageSize: 100,
  /** The largest page a client may ask for. */
  maxPageSize: 500,
  /** Most common kind-and-model rows returned with a page. */
  topModels: 12,
  /** Most common models shown as headline figures beside the total. */
  headlineModels: 3,
} as const;

/** REQ-CMDB-034 — resource utilisation: when a CI runs hot or sits idle, and the windows the console offers. */
/**
 * REQ-UI-027 — the health and telemetry fleet table. The API keeps one snapshot per tenant (CIs from Postgres, health
 * from the graph, the latest samples from ClickHouse) and answers every page, filter and sort from it, so a request
 * on a 100k-CI tenant stays inside PERF_BUDGETS.screenInteractionP95Ms. A snapshot older than snapshotMs is
 * rebuilt in the background while the old one keeps answering; the console refreshes on the same period.
 */
export const TELEMETRY = {
  snapshotMs: 30_000,
  /** Tenants whose snapshot is kept; the least recently used goes first. */
  snapshotTenants: 8,
  /**
   * Rows per page. The table shows about fourteen at once and asks for the next page as the user scrolls; fifty keeps
   * a page's GraphQL resolution (each row's CI) small enough that eight users scrolling at once stay inside the budget.
   */
  defaultPageSize: 50,
  maxPageSize: 500,
  /** Apdex at or above this is satisfied, below the frustrated mark is poor (the Apdex convention). */
  apdexGood: 0.94,
  apdexPoor: 0.7,
} as const;

export const UTILISATION = {
  /** CPU, memory or the fullest filesystem at or above this share is running hot (capacity at risk). */
  hotPercent: 85,
  /** CPU and memory both at or below this share is idle (a rightsizing or reclaim candidate). */
  idlePercent: 10,
  /** History windows a CI's Utilisation tab offers, in hours. */
  windowsHours: [24, 168, 720] as const,
  /** Default history window, in hours. */
  defaultWindowHours: 168,
  /** Points a history window is bucketed into for the chart. */
  seriesPoints: 56,
  /** A share this close below the hot threshold is shown as a warning. */
  warningMarginPercent: 15,
  /** The whole of a capacity, as the bars draw it. */
  fullPercent: 100,
  /** Decimals a utilisation percentage is shown with. */
  percentDecimals: 1,
  /** Power totals are shown in kilowatts. */
  wattsPerKilowatt: 1000,
  /** Rows per page of the utilisation register. */
  pageSize: 100,
  /** The largest page a client may ask for. */
  maxPageSize: 500,
  /** Seconds between the two CPU counter reads an agentless collector takes to compute utilisation. */
  cpuSampleSeconds: 1,
} as const;

/** REQ-CMDB-024 (ADR-043): warranty and EoX lookups by serial number. */
export const WARRANTY = {
  collectorId: 'warranty',
  /** Hardware types a lookup is planned for (the asset register's owned hardware with a serial). */
  ciTypes: ['host', 'network_device', 'storage_array', 'load_balancer', 'firewall'] as const,
  /** Assets per job: one job stays well inside the job timeout at the vendors' batch sizes and rate limits. */
  assetsPerJob: 500,
  /** Lower-cased manufacturer prefixes per vendor adapter (estate and collectors spell them several ways). */
  manufacturerPrefixes: { dell: ['dell'], lenovo: ['lenovo'], cisco: ['cisco'] },
  /** Vendors whose adapter also reports EoX milestones. */
  eoxVendors: ['cisco'],
  /** Requests per second per job, under the vendors' published per-client limits. */
  requestsPerSecond: 2,
} as const;

/**
 * REQ-CMDB-023 REQ-CMDB-025 (ADR-039) — the product lifecycle catalogue: the endoflife.date products bundled in the
 * snapshot (packages/db/lifecycle) and refreshed by the optional sync, with the kind and display title of each, and the
 * horizons the Lifecycle screen uses.
 */
export const LIFECYCLE = {
  products: [
    { product: 'ubuntu', kind: 'os', title: 'Ubuntu' },
    { product: 'debian', kind: 'os', title: 'Debian' },
    { product: 'rhel', kind: 'os', title: 'Red Hat Enterprise Linux' },
    { product: 'centos', kind: 'os', title: 'CentOS' },
    { product: 'rocky-linux', kind: 'os', title: 'Rocky Linux' },
    { product: 'almalinux', kind: 'os', title: 'AlmaLinux' },
    { product: 'oracle-linux', kind: 'os', title: 'Oracle Linux' },
    { product: 'sles', kind: 'os', title: 'SUSE Linux Enterprise Server' },
    { product: 'opensuse', kind: 'os', title: 'openSUSE Leap' },
    { product: 'amazon-linux', kind: 'os', title: 'Amazon Linux' },
    { product: 'fedora', kind: 'os', title: 'Fedora' },
    { product: 'alpine-linux', kind: 'os', title: 'Alpine Linux' },
    { product: 'windows-server', kind: 'os', title: 'Windows Server' },
    { product: 'proxmox-ve', kind: 'hypervisor', title: 'Proxmox VE' },
    { product: 'esxi', kind: 'hypervisor', title: 'VMware ESXi' },
    { product: 'vcenter', kind: 'hypervisor', title: 'VMware vCenter' },
    { product: 'nutanix-aos', kind: 'hypervisor', title: 'Nutanix AOS' },
    { product: 'cisco-ios-xe', kind: 'network_os', title: 'Cisco IOS XE' },
    { product: 'panos', kind: 'network_os', title: 'Palo Alto PAN-OS' },
    { product: 'fortios', kind: 'network_os', title: 'FortiOS' },
    { product: 'big-ip', kind: 'network_os', title: 'F5 BIG-IP' },
    { product: 'postgresql', kind: 'database', title: 'PostgreSQL' },
    { product: 'mysql', kind: 'database', title: 'MySQL' },
    { product: 'mssqlserver', kind: 'database', title: 'Microsoft SQL Server' },
    { product: 'oracle-database', kind: 'database', title: 'Oracle Database' },
    { product: 'mongodb', kind: 'database', title: 'MongoDB' },
    { product: 'redis', kind: 'database', title: 'Redis' },
    { product: 'kubernetes', kind: 'platform', title: 'Kubernetes' },
    { product: 'red-hat-openshift', kind: 'platform', title: 'Red Hat OpenShift' },
    { product: 'nginx', kind: 'platform', title: 'NGINX' },
    { product: 'tomcat', kind: 'platform', title: 'Apache Tomcat' },
    { product: 'nodejs', kind: 'platform', title: 'Node.js' },
    { product: 'python', kind: 'platform', title: 'Python' },
    { product: 'dotnet', kind: 'platform', title: '.NET' },
  ] as const,
  /** A release whose security support ends within this many days is shown as ending. */
  endingDays: 180,
  /** An OS last patched longer ago than this is flagged as behind on patches. */
  patchStaleDays: 90,
  /** Hosts listed per release when a row is opened. */
  instancesPerRelease: 50,
  /** Snapshot file bundled with each release (packages/db/lifecycle). */
  snapshotFile: 'endoflife-date.json',
  /** Concurrent product requests while fetching the catalogue. */
  fetchConcurrency: 4,
} as const;

/** REQ-CMDB-022 — the SaaS inventory: when a subscription is renewing and when its seats are underused. */
export const SAAS = {
  /** A subscription ending within this many days is renewing (the renewal decision is due). */
  renewalHorizonDays: 90,
  /** Fewer seats assigned than this share of those bought is underused (a true-down candidate). */
  underusedPercent: 60,
  /** The whole of a seat count, as utilisation is expressed. */
  fullPercent: 100,
} as const;

/** REQ-CMDB-026..029 (ADR-035) — the Commercial screen's horizons and limits. */
export const COMMERCIAL = {
  /** "Ending within" horizons the contract register offers, in days. */
  expiryHorizonsDays: [30, 90, 180, 365] as const,
  /** A contract this close to its end is shown at risk (renewal or replacement must be decided). */
  atRiskDays: 30,
  /** Escalation level a new vendor contact starts at (1 is the first call). */
  defaultEscalationLevel: 1,
  /** Deepest escalation level a vendor contact may sit at. */
  maxEscalationLevel: 5,
  /** Document locations opened as links; anything else (a file-share path) is shown as text. */
  linkProtocols: ['http:', 'https:'] as const,
} as const;

export const ASSETS = {
  warrantyHorizonsDays: [30, 90, 180, 365] as const,
  defaultWarrantyHorizonDays: 90,
  /** Lines a new plan starts with. */
  initialBomLines: 1,
  /**
   * Depreciation schedule a discovered or manually entered asset starts with (ADR-023): no method until finance
   * assigns one, the schema's one-month minimum useful life, zero residual value.
   */
  defaultUsefulLifeMonths: 1,
  /** REQ-CMDB-017: the longest useful life a schedule may state (fifty years). */
  maxUsefulLifeMonths: 600,
  /** REQ-CMDB-020: longest ERP order or delivery note reference a receipt keeps. */
  receiptReferenceMaxLength: 200,
  /** Rows of the serial-number box on the receive form; it grows with what is typed or scanned. */
  receiptSerialRows: 4,
  /** Audit actor of a unit discovery linked to its CI (ADR-034), followed by the discovery run id. */
  discoveryActorPrefix: 'discovery:',
  /** Register rows fetched per page; the register loads more on demand. */
  registerPageSize: 50,
  /** Most rows one register page may ask for (REQ-CMDB-041). */
  registerMaxPageSize: 200,
  /** Rows of the audit-note field on the details form. */
  noteRows: 2,
  /** Unknown CIs listed in the remediation panel. */
  unknownPageSize: 50,
  /** A discovered-but-unclassified device not seen for this long is probably gone: remediation suggests retiring it. */
  unknownStaleDays: 30,
  /**
   * Ports whose service is well known; an open port outside this set on an unknown device is an unknown application
   * on a non-standard port and remediation asks for a credential or a label.
   */
  wellKnownPorts: [
    22, 23, 25, 53, 80, 88, 110, 123, 135, 139, 143, 161, 389, 443, 445, 465, 514, 515, 554, 587, 631, 636,
    993, 995, 1433, 1521, 1883, 3306, 3389, 5060, 5061, 5432, 5900, 6379, 8080, 8443, 9100, 27017,
  ] as const,
} as const;

/** IPAM screen (REQ-UI-010): utilisation thresholds that colour a subnet. */
export const IPAM = {
  warnUtilisationPercent: 70,
  criticalUtilisationPercent: 90,
  /** Indent per tree level in the subnet tree, px. */
  treeIndentPx: 20,
} as const;

/** DCIM screen (REQ-UI-011): rack elevation geometry (SVG user units) and power thresholds. */
export const DCIM = {
  unitHeightPx: 14,
  rackWidthPx: 220,
  rackPaddingPx: 24,
  isoDepthPx: 18,
  /** Gap between a device plate and the unit lines; inset of the plate from the frame and of its label. */
  unitGapPx: 2,
  plateInsetPx: 6,
  plateTextInsetPx: 12,
  /** Unit numbers are printed every N units. */
  unitLabelEvery: 5,
  unitLabelOffsetPx: 4,
  unitLabelBaselinePx: 3,
  /** Longest device name printed on a plate before an ellipsis. */
  labelMaxChars: 28,
  /** Trailing hyphen-separated segments of a rack name shown on a heat-map tile (row and position). */
  tileNameSegments: 2,
  warnPowerPercent: 70,
  criticalPowerPercent: 90,
} as const;

/**
 * REQ-DCIM-007 (ADR-061) — capacity planning. Space, power, cooling and ports share the DCIM warning and critical
 * lines (70 / 90 % used); the power trend is a least-squares line over the room's daily average draw across the
 * last `trendDays`, and at least `trendMinPoints` days of samples are needed before a forecast is shown, so a quiet
 * weekend cannot read as a falling trend. The "what fits" form starts from a common 2U, 500 W, 2-port server.
 */
export const CAPACITY = {
  warnPercent: 70,
  criticalPercent: 90,
  trendDays: 30,
  trendMinPoints: 7,
  /** PDU ids bound into one ClickHouse read of daily averages (same cap reasoning as POWER.monitorIdBatch). */
  trendIdBatch: 2_000,
  defaultSpec: { heightU: 2, watts: 500, ports: 2 },
  /** Largest values the what-fits form accepts. */
  maxSpecHeightU: 48,
  maxSpecWatts: 50_000,
  maxSpecPorts: 96,
  /** Racks listed on the Capacity view before "show all". */
  rackRows: 24,
  /** Decimal places of the trend slope (kW per day) on the view. */
  trendDecimals: 2,
} as const;

/**
 * REQ-IPAM-004 (ADR-063) — switch port management. A port down for `unusedDays` is reported free to reuse (thirty days
 * spans a month-end batch window, so a port used once a month is not offered). History reads the port's versions over
 * `historyDays`; a MAC lookup lists at most `macLookupLimit` sightings; `switchSearchLimit` switches are offered when
 * choosing one; the port table pages at `portRows` before "show all".
 */
export const SWITCH_PORTS = {
  unusedDays: 30,
  historyDays: 90,
  maxHistoryVersions: 500,
  macLookupLimit: 50,
  switchSearchLimit: 12,
  portRows: 48,
  /** Ports of one device the API reads, so a chassis with every line card full stays one bounded request. */
  maxPortsPerDevice: 2_000,
  /** Longest text a MAC lookup accepts (a MAC with separators and spaces fits easily). */
  macTextMaxLength: 64,
} as const;

/**
 * REQ-SEC-011 (ADR-067) — OpenBao access. A service logs in with AppRole and logs in again once `renewAtFraction` of
 * its token's lease has passed (a token never lapses mid-request), or straight away after a 403; a token without a
 * lease (an operator's) is used as given.
 */
export const VAULT = {
  tokenHeader: 'X-Vault-Token',
  renewAtFraction: 0.75,
  loginTimeoutMs: 5_000,
  /**
   * ADR-067 step 4 — field encryption through Transit. The openbao-init job creates the key (aes256-gcm96); every
   * ciphertext starts with the prefix, which is how a stored value is told from one written before encryption.
   */
  transitMount: 'transit',
  fieldKey: 'openmap-fields',
  ciphertextPrefix: 'vault:v',
  /** Values per Transit batch request: one request per page of contacts or assets, bounded for very large backfills. */
  transitBatch: 500,
} as const;

/**
 * REQ-INT-019 (ADR-066) — backup and restore. A backup set is a directory under BACKUP_DIR holding the Postgres custom
 * archive, the ClickHouse native backup and a manifest; Memgraph and Meilisearch are derived from Postgres and rebuilt by
 * `reproject` after a restore rather than backed up. The script keeps the newest `keepDefault` complete sets; a
 * deployment whose newest complete set is older than `staleHours` (a daily schedule plus slack) is reported stale.
 * `reproject` writes `reprojectBatch` CIs or relationships per graph transaction and search request.
 */
export const BACKUP = {
  formatVersion: 'openmap-backup/1',
  manifestFile: 'manifest.json',
  postgresFile: 'postgres.dump',
  clickhouseDir: 'clickhouse',
  keepDefault: 7,
  staleHours: 26,
  reprojectBatch: 2_000,
  listLimit: 50,
  /** The console prints set sizes in mebibytes. */
  bytesPerMegabyte: 1_048_576,
} as const;

/**
 * REQ-INT-017 (ADR-075) — backup and DR awareness: the `backup` collector reads Veeam Backup & Replication, Commvault
 * and Rubrik CDM and reports which CIs each backup policy (a Veeam job, a Commvault plan or storage policy, a Rubrik SLA
 * domain) protects, as `backed_by` edges carrying the last good backup.
 * - `defaultRpoMinutes`: the recovery point objective a CI is judged against when neither its policies nor the business
 *   services it serves state one (a daily backup, the most common default schedule of all three products).
 * - `criticalMaxTier`: business services of this tier or more critical (lower number) make their supporting CIs
 *   critical, the ITSM "high" priority class and above.
 * - The support walk goes from each critical service's members down `supportEdgeTypes` (`contains` only from logical
 *   containers, as the impact walk) for at most `supportWalkDepth` hops, enough for application → component → VM →
 *   hypervisor → host.
 * - A database or database cluster without a cover of its own inherits the covers of the compute it is hosted on whose
 *   agents include one of `databaseAgents` (an application-aware backup; an image of the VM alone is not one).
 * - A policy lists at most `unmatchedNamesMax` vendor objects the collector could not match to the CMDB.
 * - A planned job carries the CMDB inventory of `inventoryTypes`, so vendor objects (a vCenter moRef, a VM or client
 *   name) are matched to the CI identity the CMDB stores; `requestsPerSecond` and `jobTimeoutMs` bound a job.
 * - The gaps list returns `gapsDefaultFirst` rows unless asked for more, at most `gapsMaxFirst`.
 */
export const BACKUP_AWARENESS = {
  collectorId: 'backup',
  vendors: ['veeam', 'commvault', 'rubrik'],
  defaultRpoMinutes: 1_440,
  criticalMaxTier: 2,
  supportEdgeTypes: ['contains', 'depends_on', 'runs_on', 'hosted_on'],
  supportWalkDepth: 6,
  databaseAgents: ['SQL Server', 'Oracle', 'Oracle RAC', 'PostgreSQL', 'MySQL', 'SAP HANA', 'DB2', 'Sybase'],
  protectableTypes: ['vm', 'host', 'database', 'database_cluster'],
  inventoryTypes: ['vm', 'host'],
  unmatchedNamesMax: 20,
  requestsPerSecond: 10,
  jobTimeoutMs: 1_800_000,
  gapsDefaultFirst: 100,
  gapsMaxFirst: 1_000,
  /** The console's gap table rows before "show all". */
  gapRows: 50,
} as const;

/**
 * REQ-INT-009 (ADR-065) — notifications to webhooks, Slack, Teams, email and PagerDuty from the event stream. One
 * integration sends at most `maxPerWindow` messages per `windowMs`; the rest are counted as suppressed so a burst of CI
 * changes cannot flood a channel. A message carries at most `maxFacts` facts of at most `factMaxLength` characters.
 * Webhooks are signed with HMAC-SHA256 over `<timestamp>.<body>` and carry the headers below; receivers reject a
 * timestamp older than their own tolerance. SMTP waits `smtpTimeoutMs` for each reply.
 */
export const NOTIFICATION = {
  windowMs: 60_000,
  maxPerWindow: 30,
  maxFacts: 10,
  factMaxLength: 200,
  smtpTimeoutMs: 10_000,
  /** SMTP reply codes: 220 greeting, 250 ok, 235 authenticated, 334 continue, 354 start data, 221 closing. */
  smtpCodes: {
    ready: 220,
    ok: 250,
    forwarded: 251,
    authenticated: 235,
    authContinue: 334,
    startData: 354,
    closing: 221,
  },
  /** Replies from this code up are permanent refusals (RFC 5321 5yz): not retried. */
  smtpPermanentFrom: 500,
  /** Digits of an SMTP reply code. */
  smtpReplyCodeLength: 3,
  /** Longest base64 line in a MIME body (RFC 2045). */
  base64LineLength: 76,
  /** Characters of an ISO timestamp kept in a message footer (YYYY-MM-DDTHH:MM). */
  footerTimeLength: 16,
  smtpDefaultPort: 25,
  smtpsDefaultPort: 465,
  signatureHeader: 'x-openmap-signature',
  timestampHeader: 'x-openmap-timestamp',
  eventHeader: 'x-openmap-event',
  deliveryHeader: 'x-openmap-delivery',
  signatureVersion: 'v1',
  /** The Adaptive Card version Teams renders in incoming-webhook messages. */
  adaptiveCardVersion: '1.4',
  adaptiveCardContentType: 'application/vnd.microsoft.card.adaptive',
  /** PagerDuty Events API v2 enqueue path on the integration's endpoint. */
  pagerDutyEnqueuePath: 'v2/enqueue',
  /** After a test is queued the console re-reads the deliveries every `testPollMs` for `testPollForMs` (the engine sends it in the background). */
  testPollMs: 2_000,
  testPollForMs: 30_000,
} as const;

/**
 * REQ-INT-012 (ADR-073) — monitoring event ingest: Prometheus Alertmanager, Zabbix, Nagios / Icinga, Datadog,
 * SolarWinds Orion and Splunk post their alerts to `POST /<ingestPath>/<integrationId>`. A request authenticates with
 * the integration's OpenBao credential (bearer token, basic credentials or an HMAC signature over
 * `<timestamp>.<body>` in the notification headers, ADR-065); a sender that can only be given a URL (Splunk's webhook
 * action) appends the token as one more path segment when the integration allows it. Credentials are cached for
 * `secretCacheMs`, so a burst of alerts reads OpenBao once. Text is capped so one payload cannot fill a row.
 */
export const MONITORING = {
  ingestPath: 'ingest/monitoring',
  /** Severity of an alert whose payload names none OpenMap recognises. */
  defaultSeverity: 'medium',
  titleMaxLength: 300,
  descriptionMaxLength: 2_000,
  labelValueMaxLength: 500,
  maxLabels: 64,
  /** Alerts accepted in one request (Alertmanager groups many alerts per notification). */
  maxAlertsPerRequest: 1_000,
  /** Targets kept per alert: what it names the affected thing by (CI id, FQDN, hostname, address, instance). */
  maxTargets: 12,
  /** A signed request older (or newer) than this is a replay and is refused. */
  signatureToleranceMs: 300_000,
  secretCacheMs: 30_000,
  /** Alerts from senders with no resolve message (Splunk) clear after this long unless the integration sets its own. */
  pointInTimeTtlMinutes: 60,
  /** The BSM engine re-reads changed alerts this often, besides being woken by each ingest event. */
  engineSyncMs: 10_000,
  /** Changed rows are re-read from this far before the newest change already seen: writers' clocks may differ. */
  syncOverlapMs: 5_000,
  /** Alerts the console lists by default, and at most. */
  defaultPageSize: 100,
  maxPageSize: 500,
  screenRefreshMs: 10_000,
  /** Alertmanager webhook payload version this adapter reads. */
  alertmanagerWebhookVersion: '4',
  /** Go's zero time, which Alertmanager sends as `endsAt` of a firing alert. */
  zeroTimePrefix: '0001-',
  /** Audit actions written by the console's mapping and clearing (the engine re-reads alerts when it sees them). */
  auditActions: { mapped: 'monitoring.source.mapped', cleared: 'monitoring.alert.cleared' },
  /** Delivery event data marker the engine reacts to (an inbound monitoring delivery). */
  deliveryKind: 'monitoring',
} as const;

/**
 * REQ-IPAM-005 (ADR-064) — firewall rules and policy objects. Evaluation follows jumps and gotos to `maxJumpDepth`
 * chains (netfilter itself stops at 16) and group references to `maxObjectDepth` levels (vendors nest groups a few
 * deep). The shadow analysis is quadratic per chain, so a device's first `analysisRuleLimit` rules are analysed and the
 * rest reported as not analysed. A traffic check evaluates at most `checkDeviceLimit` devices; the API reads at most
 * `maxRulesPerTenant` rules for one check, enough for a large estate's firewalls without an unbounded read. The device
 * picker offers `deviceSearchLimit` devices; the rule table pages at `ruleRows` before "show all".
 */
export const FIREWALL = {
  maxJumpDepth: 16,
  maxObjectDepth: 8,
  analysisRuleLimit: 5_000,
  checkDeviceLimit: 50,
  maxRulesPerTenant: 50_000,
  maxRulesPerDevice: 20_000,
  deviceSearchLimit: 12,
  ruleRows: 100,
  /** Longest address or service text a traffic check accepts (an IPv6 address with a prefix fits easily). */
  checkTextMaxLength: 64,
  /** Highest TCP/UDP port (16-bit port field). */
  maxPort: 65_535,
  /** Longest protocol word a traffic check accepts (icmpv6, udplite and protocol numbers fit). */
  protocolMaxLength: 16,
} as const;

/** Vulnerabilities screen (REQ-UI-016, REQ-SEC-008): the blast-radius walk from affected hosts to business services. */
export const VULNERABILITY = {
  /** Hosts walked per CVE; a CVE on more hosts reports a truncated blast radius rather than blowing the query budget. */
  maxBlastRadiusHosts: 25,
  /** Upstream depth of each walk; the layer model's deepest chain fits in the graph default. */
  blastRadiusDepth: 0,
  /** CVSS floors offered by the Vulnerabilities screen filter (NVD low/medium/high/critical boundaries). */
  cvssFilterSteps: [4, 7, 9] as const,
  /** CVSS at or above this is counted as critical in headline figures. */
  criticalCvssMin: 9,
} as const;

/** Software and licences screen (REQ-UI-015, REQ-CMDB-031). */
export const SOFTWARE = {
  /** Licences expiring within this many days are flagged. */
  expiryHorizonDays: 90,
} as const;

/** Embedded Superset analytics (REQ-UI-017). Names are stable keys the provisioner looks up, never shown raw. */
export const ANALYTICS = {
  databaseName: 'OpenMap ClickHouse',
  dashboardSlug: 'openmap-estate',
  dashboardTitle: 'OpenMap estate analytics',
  /** Superset role the guest token assumes; the provisioner grants it Gamma's permissions once. */
  guestRole: 'OpenMapEmbedded',
  templateRole: 'Gamma',
  guestFirstName: 'OpenMap',
  guestLastName: 'Console',
  /** Row limit for every provisioned chart. */
  chartRowLimit: 10_000,
  /** Dashboard grid: Superset rows are 12 columns wide; chart heights are in grid units of 8 px. */
  gridColumns: 12,
  chartHeight: 50,
  /** Superset REST call timeout. */
  requestTimeoutMs: 15_000,
  /** Guest token lifetime; mirrors GUEST_TOKEN_JWT_EXP_SECONDS in superset_config.py. */
  guestTokenSeconds: 300,
  /** Charts per dashboard row for the wide and the narrow rows. */
  chartsPerWideRow: 2,
  chartsPerNarrowRow: 3,
  /** Characters of a Superset error body carried into the API's error message. */
  errorExcerptChars: 300,
  /** Colour scheme registered in superset_config.py (EXTRA_CATEGORICAL_COLOR_SCHEMES) that charts are provisioned with. */
  colorScheme: 'openmapHorizon',
  /** Series colours of that scheme, in the order Superset assigns them: the Horizon accents (packages/ui tokens). */
  schemeColors: [
    '#22D3EE',
    '#8B5CF6',
    '#2DD4A0',
    '#F5B82E',
    '#FB5B7A',
    '#38BDF8',
    '#A78BFA',
    '#F472B6',
    '#34D399',
    '#FBBF24',
  ] as const,
  /** Surfaces the provisioned dashboard CSS paints with; mirrors the console's ground, surface1, glass border and text tokens. */
  theme: {
    ground: '#070A12',
    surface: '#0D1322',
    border: 'rgba(255,255,255,0.08)',
    text: '#E6EAF2',
    muted: '#9AA4B8',
    accent: '#22D3EE',
    cardRadiusPx: 14,
    cardShadow: '0 24px 48px -12px rgba(0,0,0,0.55)',
    hoverBorder: 'rgba(34,211,238,0.35)',
    fontFamily: "'Sora', 'Inter', system-ui, sans-serif",
  },
} as const;

/**
 * REQ-AI-002 — fingerprints for classifying CIs discovery could only call `unknown` (a port scan finds an address,
 * open ports, a MAC vendor and, when SNMP or HTTP answer, a description and a banner). Each fingerprint names a device
 * class, the layer and, where the CMDB has one, the type such a device belongs to; and the evidence that points at
 * it: patterns over the SNMP sysDescr, the HTTP banner and the OUI vendor (case-insensitive regular expressions), and
 * the well-known ports the class listens on. The patterns name product families and protocols, not one model, so a
 * fingerprint recognises devices it was not written from.
 * - Ports, by protocol: 9100 raw printing (JetDirect), 515 LPD, 631 IPP; 554 RTSP video; 5060/5061 SIP; 7001 MagicINFO;
 *   4050 HID VertX; 1911/4911 Niagara Fox, 47808 BACnet/IP; 4343 Aruba controller; 1883/8883 MQTT; 5000 cash-device
 *   management.
 */
export const DEVICE_FINGERPRINTS = [
  {
    deviceClass: 'printer',
    layer: 'hardware',
    type: null,
    sysDescr: 'printer|jetdirect|laserjet|link-os|officejet|imagerunner|bizhub|card printer|primacy',
    banner: 'printer|jetdirect',
    vendor: 'hp|zebra|lexmark|canon|ricoh|xerox|brother|kyocera|evolis|fargo',
    ports: [9100, 515, 631],
  },
  {
    deviceClass: 'network_camera',
    layer: 'dc',
    type: null,
    sysDescr: 'camera|ipc|nvr|ds-2cd|ds-2de|ptz',
    banner: 'camera|axis|hikvision|dahua',
    vendor: 'axis|hikvision|dahua|hanwha|bosch|avigilon|vivotek',
    ports: [554],
  },
  {
    deviceClass: 'ip_phone',
    layer: 'hardware',
    type: null,
    sysDescr: 'ip phone|sip phone|sip[0-9]{2}|voip',
    banner: 'phone',
    vendor: 'cisco|yealink|polycom|grandstream|avaya|snom',
    ports: [5060],
  },
  {
    deviceClass: 'video_conference',
    layer: 'hardware',
    type: null,
    sysDescr: 'studio x|room kit|codec|webex|video conferenc|rally|g7500',
    banner: 'poly|webex',
    vendor: 'poly|cisco|logitech|neat|yealink',
    ports: [5060, 5061],
  },
  {
    deviceClass: 'digital_signage',
    layer: 'hardware',
    type: null,
    sysDescr: 'magicinfo|signage|brightsign|webos signage|smart signage',
    banner: 'signage',
    vendor: 'samsung|lg|brightsign|philips',
    ports: [7001],
  },
  {
    deviceClass: 'access_control',
    layer: 'dc',
    type: null,
    sysDescr: 'vertx|access control|door controller|lenel|genetec|mercury|gallagher',
    banner: 'access',
    vendor: 'hid|lenel|genetec|gallagher|suprema',
    ports: [4050],
  },
  {
    deviceClass: 'building_management',
    layer: 'dc',
    type: null,
    sysDescr: 'niagara|bacnet|webs-n4|metasys|desigo|building',
    banner: 'niagara|bacnet',
    vendor: 'honeywell|johnson controls|siemens|schneider|tridium',
    ports: [1911, 4911, 47808],
  },
  {
    deviceClass: 'ups_management',
    layer: 'dc',
    type: 'ups',
    sysDescr: '\\bups\\b|network management card|management card|smart-ups|powerware|galaxy',
    banner: 'ups|schneider|eaton',
    vendor: 'schneider|apc|eaton|vertiv|riello',
    ports: [161],
  },
  {
    deviceClass: 'wireless_access_point',
    layer: 'network_security',
    type: 'network_device',
    sysDescr: 'access point|arubaos|\\bap-[0-9]|unifi|meraki mr|aironet|ruckus',
    banner: 'aruba|unifi',
    vendor: 'aruba|ubiquiti|ruckus|cisco|meraki|cambium',
    ports: [4343],
  },
  {
    deviceClass: 'iot_gateway',
    layer: 'hardware',
    type: 'host',
    sysDescr: 'raspberry pi|esp32|arduino|jetson|beaglebone',
    banner: 'mqtt',
    vendor: 'raspberry pi|espressif|arduino|nvidia',
    ports: [1883, 8883],
  },
  {
    deviceClass: 'cash_handling',
    layer: 'hardware',
    type: null,
    sysDescr: 'glory|cash|banknote|note counter|coin|recycler',
    banner: 'glory|cash',
    vendor: 'glory|de la rue|cummins allison|laurel',
    ports: [5000],
  },
] as const;

/**
 * REQ-AI-003 (ADR-053) — anomaly rules over discovery and health events. A flapping service changed health
 * flapChanges times within flapWindowHours: three down-and-back cycles in an afternoon, where the synthetic estates'
 * ordinary history peaks at two changes in any six hours. The API evaluates every ANOMALY_INTERVAL_MS (env).
 */
export const ANOMALY = {
  flapChanges: 6,
  flapWindowHours: 6,
  /** Days of health history the flapping rule reads. */
  flapLookbackDays: 30,
  /** Claimants that make an address a conflict: more than one device answering on it. */
  conflictClaimants: 2,
  /** Located-in hops from a device up to its site. */
  locationHops: 5,
  /** Site kinds where an unmanaged device is an anomaly. */
  datacenterKinds: ['datacenter', 'colocation'],
  findingsListLimit: 200,
  /** Cleared findings stay listed this long after they cleared. */
  clearedListedMs: 604_800_000,
  /** How often the Anomalies screen re-reads the findings; the rules run on the API's interval. */
  screenRefreshMs: 60_000,
  /** The planted burst in the synthetic health history: outages, their length and the gap between them. */
  synthetic: { flapOutages: 4, flapOutageMinutes: 6, flapGapMinutes: 25, flapEndsHoursBeforeNow: 3 },
} as const;

/**
 * REQ-AI-005 (ADR-054) — the cloud recommendation model over each cloud resource's state, monthly cost and load
 * (cloud.resource.load_percent): release what is stopped but still billed, decommission compute that is idle, downsize
 * compute that never comes near its size, upsize compute that runs hot. One size step down within an instance family
 * halves the price on the major clouds, so downsizing saves rightsizeSavingShare of the monthly cost.
 */
export const CLOUD_ADVICE = {
  /** Resource types that have a size to change and run continuously (functions and managed queues do not). */
  computeTypes: [
    'AWS::EC2::Instance',
    'AWS::RDS::DBInstance',
    'Microsoft.Compute/virtualMachines',
    'Microsoft.Sql/servers/databases',
    'Microsoft.Web/sites',
  ],
  idlePeakPercent: 5,
  rightsizePeakPercent: 40,
  rightsizeAveragePercent: 30,
  /** UTILISATION.hotPercent: the same line the utilisation register calls hot. */
  upsizeAveragePercent: 85,
  rightsizeSavingShare: 0.5,
  /** Days of load history read; with none in the window the latest sample stands, with its age shown. */
  lookbackDays: 14,
  attributes: {
    type: 'resourceType',
    state: 'state',
    cost: 'monthlyCostUsd',
    sku: 'sku',
    region: 'region',
    owner: 'tagOwner',
    environment: 'tagEnvironment',
  },
  stoppedStates: ['stopped', 'deallocated', 'available'],
  moneyDecimals: 2,
} as const;

/**
 * REQ-INT-016 (ADR-074) — identity federation. Administrators register directories (Active Directory, other LDAP) and
 * OpenID Connect providers (Entra ID, Okta, any other); the API applies each one to the Keycloak realm people sign in
 * to, through Keycloak's admin REST API. Every Keycloak object OpenMap creates carries `objectPrefix`, so OpenMap never
 * edits or removes one it did not create. An alias is the source name made URL-safe plus `aliasSuffixLength` characters
 * of the source id (unique across tenants sharing a realm, and fixed once created because an OIDC provider's redirect
 * URI contains it). The LDAP presets are Keycloak's own defaults per vendor (its admin console fills the same values);
 * the OIDC presets are each vendor's documented scopes and group claim (Okta emits `groups` only when the scope asks).
 */
export const IDENTITY_FEDERATION = {
  objectPrefix: 'openmap',
  aliasSuffixLength: 8,
  maxNameLength: 80,
  maxDnLength: 512,
  maxRoleMappings: 50,
  maxGroupLength: 256,
  /** Groups read per admin call when listing the groups below a source's group. */
  keycloakPageSize: 1000,
  /** Bounds of a directory's periodic full sync; no period means sync on request only. */
  minSyncPeriodMinutes: 5,
  maxSyncPeriodMinutes: 10_080,
  /** Keycloak admin access tokens are renewed this long before they expire. */
  adminTokenMarginMs: 10_000,
  /** One admin REST call (create, read, update, test). */
  requestTimeoutMs: 15_000,
  /** A full directory sync imports every user in one call; a large directory needs minutes. */
  syncTimeoutMs: 300_000,
  /** How long Keycloak waits for the directory to answer a connection (its `connectionTimeout`). */
  ldapConnectionTimeoutMs: 10_000,
  /** Users per page Keycloak reads during a sync (its `batchSizeForSync`). */
  ldapSyncBatchSize: 1000,
  /** The user attribute carrying the tenant: the realm's `tenant` token mapper reads it (REQ-CORE-012). */
  tenantAttribute: 'tenant',
  /** Field of the OpenBao record (at the source's secretRef) holding the bind password or the client secret. */
  secretFields: { ldap: 'password', oidc: 'clientSecret' },
  ldap: {
    active_directory: {
      keycloakVendor: 'ad',
      usernameAttribute: 'sAMAccountName',
      rdnAttribute: 'cn',
      uuidAttribute: 'objectGUID',
      userObjectClasses: 'person, organizationalPerson, user',
      groupObjectClasses: 'group',
      groupNameAttribute: 'cn',
      membershipAttribute: 'member',
    },
    ldap: {
      keycloakVendor: 'other',
      usernameAttribute: 'uid',
      rdnAttribute: 'uid',
      uuidAttribute: 'entryUUID',
      userObjectClasses: 'inetOrgPerson, organizationalPerson',
      groupObjectClasses: 'groupOfNames',
      groupNameAttribute: 'cn',
      membershipAttribute: 'member',
    },
  },
  oidc: {
    entra_id: { scopes: 'openid profile email', groupsClaim: 'groups' },
    okta: { scopes: 'openid profile email groups', groupsClaim: 'groups' },
    oidc: { scopes: 'openid profile email', groupsClaim: 'groups' },
  },
  /** OpenID Connect Discovery 1.0 §4: the provider configuration document below the issuer. */
  discoveryPath: '/.well-known/openid-configuration',
  /** Entra ID's v2.0 endpoints: issuer `<authority>/<directory tenant>/v2.0`. */
  entraIssuerSuffix: 'v2.0',
  /** Okta custom authorization servers: issuer `<domain>/oauth2/<server id>` over HTTPS; none means the org server. */
  oktaServerPath: 'oauth2',
  /** The Keycloak flow a first brokered sign-in runs (creates the local user, links it to the provider). */
  firstBrokerLoginFlow: 'first broker login',
} as const;

/**
 * REQ-INT-016 (ADR-074) — Keycloak's own identifiers for the objects identity federation creates: component types and
 * provider ids of its LDAP user storage, LDAP mappers, OIDC brokering and identity-provider mappers. They are protocol
 * names fixed by Keycloak (some carry the word Keycloak itself chose for a fixed-value mapper), not deployment settings.
 */
export const KEYCLOAK_PROVIDERS = {
  userStorageType: 'org.keycloak.storage.UserStorageProvider',
  ldapMapperType: 'org.keycloak.storage.ldap.mappers.LDAPStorageMapper',
  ldapProvider: 'ldap',
  groupMapperProvider: 'group-ldap-mapper',
  /** The LDAP mapper that gives every user of the directory the same attribute value. */
  attributeMapperProvider: 'hardcoded-attribute-mapper',
  oidcProvider: 'oidc',
  claimToRoleMapper: 'oidc-role-idp-mapper',
  /** The identity-provider mapper that gives every brokered user the same attribute value. */
  attributeIdpMapper: 'hardcoded-attribute-idp-mapper',
  /** LDAP search scope "subtree" (javax.naming SearchControls.SUBTREE_SCOPE). */
  subtreeScope: '2',
  /** Keycloak's "no periodic sync" value for fullSyncPeriod / changedSyncPeriod. */
  noPeriod: '-1',
} as const;

/**
 * REQ-IPAM-003 (ADR-055) — two-way DNS sync. Every DNS_SYNC_INTERVAL_MS (env) the scheduler looks at the zones kept in
 * sync: a zone with pending changes, or whose last pull is older than DNS_PULL_INTERVAL_MS (env), gets one `dns` job
 * carrying the changes (RFC 2136) and the transfer that confirms them. A zone whose job has not finished waits, unless
 * the job is older than staleJobMs (its Node went away).
 */
export const DNS_SYNC = {
  collectorId: 'dns',
  defaultPort: 53,
  defaultTtl: 3600,
  staleJobMs: 600_000,
  changesListLimit: 200,
  /** The job option naming the zone sync a job belongs to, so its result settles that zone's changes. */
  syncOption: 'dnsSyncId',
  credentialType: 'api_token',
  /** How often the DNS tab re-reads while a change is pending or sent. */
  screenRefreshMs: 5_000,
} as const;

/**
 * REQ-DCIM-001 (ADR-056) — cabling: patch panels, cables, cross-connects and carrier circuits. A patch panel position
 * joins its front and rear, so a trace walks through it; maxTraceHops stops a trace on a mis-patched loop long before
 * any real path (a structured cabling run rarely crosses more than four panels) is cut short.
 */
export const CABLING = {
  /** The largest patch panel accepted: 96 positions is the densest panel sold in 1U (MPO/LC high density). */
  maxPanelPorts: 96,
  maxTraceHops: 32,
  /** Search hits offered when choosing a cable end on the Cabling tab. */
  endpointSearchLimit: 8,
  /** The layers whose CIs can be a cable end: patch panels and PDUs (dc), switches and their ports, servers. */
  endpointLayers: ['dc', 'network_security', 'hardware'],
  /** REQ-DCIM-008: a cable label's length, the contract's limit; a label suggested from two port names is cut to it. */
  labelMaxChars: 64,
  /** Observed links listed on the Cabling tab as undocumented before "show all". */
  undocumentedRows: 20,
  /**
   * Undocumented links one verification read returns; the summary carries the full count. An estate that has recorded
   * no cables yet has every adjacency undocumented, and a screen does not need eighty thousand rows to say so.
   */
  undocumentedLimit: 200,
} as const;

export const CLASSIFICATION = {
  /** Weights of each kind of evidence; their sum is the most a fingerprint can score. sysDescr is the device's own words. */
  weights: { sysDescr: 0.5, banner: 0.15, vendor: 0.15, ports: 0.2 },
  /** Below this score no suggestion is made: a vendor or a port alone (a Cisco MAC, port 161) proves nothing. */
  minConfidence: 0.4,
  /** Unknown CIs classified per sweep, so a large tenant's first sweep stays a bounded request. */
  sweepLimit: 5_000,
  /** Characters of the sysDescr kept as the suggested label's title. */
  titleChars: 80,
  /** Decimals a confidence is rounded to. */
  confidenceDecimals: 2,
} as const;

export const ASSISTANT = {
  maxRowsReturned: 200,
  /** Names listed in a summary before "and N more". */
  summaryNames: 5,
  maxCypherLength: 4_000,
  maxQuestionLength: 2_000,
  /** Cypher execution timeout for assistant queries, milliseconds. */
  queryTimeoutMs: 15_000,
  temperature: 0.1,
  /** Times a rejected query is sent back to the model with the reason before the question is refused. */
  repairAttempts: 2,
  /**
   * ADR-028 — the conversational pipeline. A retrieval step that outlives this budget is reported as evidence with an
   * error rather than hanging the answer; the follow-up count keeps the chips to one row; the accuracy floor is what
   * `apps/assistant` evaluation set must reach in CI before the catalogue is considered sound.
   */
  skillTimeoutMs: 20_000,
  followUps: 3,
  evalAccuracyMin: 0.9,
  /** Pattern-matched intents below this confidence ask the model to classify; below it again, the user is asked. */
  minIntentConfidence: 0.6,
  /**
   * How much each vocabulary match adds to the classifier's confidence (capped at 1). An intent marker alone, or a
   * CI type with an aggregate, clears `minIntentConfidence`; a bare type does not, so the model is consulted.
   */
  intentConfidence: {
    base: 0.3,
    marker: 0.4,
    type: 0.3,
    measurement: 0.25,
    attribute: 0.15,
    aggregate: 0.1,
    name: 0.2,
  },
  /** Rows a top-N or distribution answer lists before "and N more". */
  topN: 10,
  /** Distinct values an attribute may have to count as a filterable dimension (site, platform, cluster, role). */
  filterValueLimit: 60,
  /** Candidate CIs offered when a name is ambiguous. */
  clarificationChoices: 5,
  /** Decimal places of a computed figure in prose, and the base the grounding guard rounds in when matching them. */
  decimals: 2,
  decimalBase: 10,
  /** How long the discovered attribute keys and filter values of a tenant stay cached in the API process. */
  catalogueCacheMs: 300_000,
  /** Sentences the model may write before the deterministic summary takes over. */
  maxProseSentences: 5,
  /** Length of a retrieval query kept as evidence on the answer. */
  evidenceQueryMaxLength: 4_000,
  /** A greeting or thanks this short is answered without running a skill. */
  smallTalkMaxWords: 4,
  /** Rows a skill may return to the composer and the evidence; larger sets are summarised in the store. */
  skillRowLimit: 500,
  /**
   * ADR-028 increment two (REQ-AI-008): conversations. A conversation's title is the first question clipped; the
   * list shows the newest conversations of the person; a question this short with no intent marker of its own is
   * read against the previous turn ("and last month?", "and for VMs?").
   */
  conversationTitleLength: 80,
  conversationListLimit: 50,
  followUpMaxWords: 6,
  /** A follow-up inherits the previous turn's reading, so its confidence is at least the floor that ran that turn. */
  followUpConfidence: 0.75,
  /**
   * `metrics.series`: a range question ("CPU of host X over the last 7 days") is averaged into this many buckets for
   * the evidence rows and the trend; a calendar period in a measurement question ("last month") is read as a rolling
   * window of the given days; "last week" is seven days; a trend within the flat band is reported as flat.
   */
  seriesBuckets: 48,
  rollingDays: { month: 30, quarter: 90, year: 365 },
  weekDays: 7,
  seriesFlatPercent: 5,
  seriesDefaultDays: 7,
  /**
   * CI ids bound into one ClickHouse read. Query parameters travel in the HTTP query string, which ClickHouse caps
   * per field (http_max_field_value_size, 128 KiB by default): a UUID array costs about 40 bytes an id, so a scope of
   * 40,000 hosts is read in batches of this size and the partial aggregates are combined. Batches run this many at
   * a time.
   */
  clickhouseIdBatch: 2_000,
  clickhouseBatchConcurrency: 4,
} as const;

/**
 * REQ-BSM-004 (ADR-047) — impact prediction accuracy. Each sweep validates at most `sweepBatch` incidents per tenant
 * (the oldest resolved first), so a backlog of thousands drains over several ticks without holding a connection for
 * minutes. An incident replay simulates the root cause `failed` over the whole upstream closure (maxDepth 0) with
 * redundancy honoured, as a person's default scenario does. A missed service is suggested as served by the root cause
 * (root part_of_service service): the edge the impact traversal follows into services. The accuracy histogram buckets cover 0..1 in tenths; lists default to these lengths and cap at listMax.
 */
export const IMPACT = {
  sweepBatch: 50,
  replayKind: 'failed',
  replayMaxDepth: 0,
  replayActor: 'impact-validation',
  suggestionType: 'part_of_service',
  suggestionReason: 'impact_miss',
  accuracyBuckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
  recentDefault: 20,
  suggestionsDefault: 50,
  listMax: 200,
} as const;

/**
 * REQ-BSM-007 (ADR-025) — inter-site link probes. Each round makes `attempts` TCP connections per link, `gapMs`
 * apart, each bounded by `timeoutMs`; a target without a port uses `defaultPort` (HTTPS, open on most gateways and
 * Node hosts). A job may run for every attempt's timeout plus the gaps, rounded up to `jobTimeoutMs`.
 */
export const LINK_PROBE = {
  collectorId: 'link_probe',
  attempts: 5,
  timeoutMs: 2_000,
  gapMs: 100,
  defaultPort: 443,
  jobTimeoutMs: 30_000,
  /** An unfinished probe job older than this no longer holds its Node back (the Node went away mid-round). */
  staleJobMs: 120_000,
  /** Finished probe jobs (and their runs) are kept this long; the samples stay in ClickHouse under its own TTL. */
  retainMs: 86_400_000,
} as const;

/**
 * REQ-BSM-007 (ADR-025) — link health and HA / DR readiness. A link losing this share of its probes, or slower than
 * its committed latency (else `degradedLatencyMs`), is degraded; a link not probed for `staleAfterProbes` probe
 * intervals is unknown. A criticality-1 site needs `minDiversePaths` healthy paths. Rules are evaluated every
 * `evaluateMs`; a `dr_reachable` breach opens a high incident, the others medium.
 */
export const READINESS = {
  evaluateMs: 60_000,
  degradedLossPercent: 5,
  degradedLatencyMs: 150,
  staleAfterProbes: 3,
  minDiversePaths: 2,
  criticalSite: 1,
  incidentSource: 'readiness',
  /** Cleared findings stay listed this long after they cleared. */
  clearedListedMs: 604_800_000,
  findingsListLimit: 100,
  /**
   * REQ-IPAM-007 (ADR-069): two links that claim to be diverse but share a provider, a physical route or a carrier
   * circuit are a design risk with nothing down yet (low); a link down between two sites that had more than one path is
   * lost redundancy with traffic still flowing on the rest (medium, as diverse_paths).
   */
  severity: { diverse_paths: 'medium', dr_reachable: 'high', replication_healthy: 'medium', path_diversity: 'low', redundancy_lost: 'medium' },
  /** REQ-UI-026 — incident states a site card counts as alerts: everything not yet resolved or closed. */
  alertIncidentStates: ['open', 'acknowledged', 'mitigated'],
  /**
   * REQ-UI-026 — located_in hops from a CI up to its site: device, rack, row, room, building, site. An incident's
   * root cause is walked up at most this far to find the site whose card counts it.
   */
  locationHops: 5,
  megabitsPerGigabit: 1_000,
} as const;

/**
 * REQ-IPAM-007 (ADR-069) — the network circuit register on inter-site links.
 */
export const LINK_CIRCUITS = {
  /** Carrier circuits one inter-site link rides on: a local loop at each end, a backbone and a spare is four; eight is ample. */
  maxCircuitsPerLink: 8,
  /** Diverse paths one link may claim; above this a figure is a typing error, not a circuit. */
  maxDiversePaths: 16,
  /** Longest provider, contract and route reference accepted, as the cabling circuit's provider and id (ADR-056). */
  maxRefChars: 128,
  /** CI types at a circuit's ends whose health is the circuit's hand-off: a down port takes the circuit down. */
  handOffTypes: ['interface', 'port'],
} as const;

/**
 * REQ-PERF-002 — GraphQL execution. Mercurius compiles a query with graphql-jit once it has run this many times: large
 * results (an impact closure of 31,000 nodes) spend most of their time in per-field execution, which the compiled
 * query cuts. A one-off query still runs on the interpreter.
 */
export const GRAPHQL_EXECUTION = {
  jitAfterRuns: 1,
} as const;

/** Reconciler and outbox dispatcher pacing. */
export const RECONCILER = {
  /** Outbox rows claimed per dispatcher tick; every target receives the batch in one round trip. */
  outboxBatchSize: 1_000,
  /** Idle wait between dispatcher ticks when the outbox is empty. */
  outboxIdleMs: 1_000,
  /**
   * REQ-CORE-020 — how long a claimed batch stays reserved for its dispatcher. A dispatcher that dies mid-batch releases
   * its rows when the lease runs out. A batch normally lands in about a second, but a busy graph retries conflicting
   * transactions for up to 30 seconds (the Bolt driver's default), so the lease is well above that.
   */
  outboxClaimLeaseMs: 300_000,
  /**
   * REQ-CORE-020 — concurrent dispatch loops per reconciler process (env RECONCILER_DISPATCHERS). Claims are leased, so
   * more loops (or replicas) are safe; but a relationship that overtakes its CI in another loop waits for a retry, and on
   * the seed-45 replay two loops were no faster than one (ADR-050).
   */
  outboxDispatchers: 1,
  /**
   * REQ-CORE-020 — rows from which a ClickHouse insert is written synchronously. Async inserts coalesce the dispatcher's
   * small steady-state batches server-side, but each one waits for the buffer flush (up to 200 ms); a batch this large
   * is already the part size ClickHouse recommends, and on the seed-45 replay that wait was most of ClickHouse's time.
   */
  clickhouseSyncInsertRows: 500,
  /**
   * REQ-CORE-020 — consecutive dispatch ticks that deliver nothing before the replay stops draining, each after
   * outboxIdleMs. A transient target failure (a ClickHouse timeout under load) keeps its rows pending; a scale-0.25
   * replay that stopped at the first one left 188,000 rows undelivered.
   */
  replayStallTicks: 30,
  /** Candidate CIs fetched per identity lookup batch. */
  lookupBatchSize: 500,
  /**
   * Lookup batch queries one result keeps in flight. With resultsConcurrency results at once this stays well inside
   * Prisma's default pool; unbounded, a 20,000-relationship result sent 101 queries at once and failed to connect.
   */
  lookupConcurrency: 6,
  /**
   * Identity tokens per array-overlap probe (migration 0031). The planner overestimates an overlap's rows about ninety
   * times; on the scale-1 tenant 500 tokens stayed a 85 ms bitmap scan and 5,000 became a 54 s sequential scan, so a
   * batch stays well under the flip.
   */
  identityTokenBatch: 250,
  /**
   * Budget for the single Postgres transaction that writes one collector result (CIs, relationships, conflicts and
   * outbox rows). Prisma's default of five seconds fits a small sweep chunk but not a 2000-device result on a busy
   * host; a 10k-device sweep must still land inside the fifteen-minute discovery budget, so two minutes per result.
   */
  persistTransactionTimeoutMs: 120_000,
  /** How long a result waits for a connection from the pool before the persist is abandoned. */
  persistTransactionMaxWaitMs: 10_000,
  /** Meilisearch index name prefix; one index per tenant keeps row-level isolation simple. */
  searchIndexPrefix: 'cis-',
  /** BullMQ stream that in-process subscribers (BSM engine, API WebSocket fan-out) consume. BullMQ forbids ':' in names. */
  eventStreamQueue: 'openmap-events',
  /** BullMQ queue carrying accepted collector results from the scheduler to the reconciler. */
  resultsQueue: 'openmap-collector-results',
  /** Worker concurrency for collector results. */
  resultsConcurrency: 4,
  /** Results between progress lines in the replay tool. */
  replayProgressEvery: 10,
  /** Pending relationships retried per pass and the attempt ceiling before they are dropped as stale. */
  pendingRelationshipBatch: 10_000,
  pendingRelationshipMaxAttempts: 20,
  /**
   * ADR-045: CIs whose `*Ref` values the pending pass retries per call, and CIs whose ref tokens it computes per call.
   * Bounded so the pass that follows every result stays a few hundred milliseconds on a 100k-CI tenant.
   */
  pendingRefBatch: 5_000,
  refTokenBackfillBatch: 5_000,
  /**
   * ADR-045 (migration 0028): the transaction setting that tells the cis trigger the reconciler wrote the ref tokens
   * itself; any other writer that changes a CI's identity, name or attributes empties them for the pending pass.
   */
  refTokensSetting: 'openmap.ref_tokens',
  refTokensWriter: 'reconciler',
  /**
   * Metric samples carried per `openmap.metric.sampled` event (ADR-016). A sweep of 10k hosts yields tens of
   * thousands of samples; chunking keeps every outbox envelope and ClickHouse insert at a few hundred kilobytes.
   */
  samplesPerEvent: 500,
} as const;

/**
 * REQ-DEP-002 (ADR-029) — application dependency mapping derived in the reconciler from what collectors observed:
 * flows between addresses (`communicates_with`), which compute owns which address (`uses_ip`), the listeners on the
 * server side (`listening_service` + `runs_on`) and the application components on both sides. The pass runs after any
 * result that carried flows, listeners, addresses or components, debounced per tenant, and on `pnpm reconciler adm`.
 */
export const ADM = {
  /** Provenance stamped on derived relationships; the API shows it as the source of the edge. */
  collectorId: 'adm',
  nodeId: 'reconciler',
  /** Attribute marking a derived edge and naming what it was derived from. */
  derivedFromKey: 'derivedFrom',
  derivedFromFlows: 'flows',
  /** Confidence per derivation kind: a flow to a known listener, to a compute with no listener on that port, between components. */
  confidence: { listener: 0.9, compute: 0.6, component: 0.85, ambiguousComponent: 0.6 },
  /** Flows below this count in the window are noise (a single probe), not a dependency. */
  minFlows: 2,
  /** Result types that make a pass worthwhile; a results-queue job carrying one of these schedules the pass. */
  triggerCiTypes: ['listening_service', 'application_component', 'ip_address'],
  triggerRelationshipTypes: ['communicates_with', 'uses_ip'],
  /** How long after the last triggering result a tenant's pass runs, so a sweep of many results runs it once. */
  debounceMs: 15_000,
  /** Addresses, listeners and flows loaded per Postgres page. */
  pageSize: 5_000,
  /** Derived relationships per synthetic result handed to the pipeline. */
  resultBatch: 2_000,
} as const;

/**
 * REQ-DEP-001 (ADR-030) — network topology maps. L2 joins devices through the interfaces they contain and the
 * neighbour links between those interfaces (LLDP/CDP `connected_to`), with hosts attached by their cabling; L3 joins
 * devices to the subnets their addresses sit in. A map is capped so the force layout stays interactive; the site
 * filter walks `located_in` (device → rack → room → building → site) up to `siteHops`.
 */
export const TOPOLOGY = {
  layers: ['l2', 'l3'],
  maxNodes: 1_500,
  siteHops: 5,
  /** Device types drawn as network nodes. */
  deviceTypes: ['network_device', 'load_balancer'],
  /** Types a host attachment may come from. */
  hostTypes: ['host', 'hypervisor'],
  /** Drawn size ring on the map: network gear on the first ring (large), hosts and subnets further out (small). */
  deviceDepth: 1,
  endpointDepth: 3,
} as const;

/**
 * REQ-DEP-004 (ADR-031) — the layered application map: an application's components by tier, each with where it runs
 * (VM, host, workload, cloud resource, and what those run on, up to `placementHops`), its databases, and the
 * dependencies between components inside the application and to other applications. Tiers are drawn left to right
 * in `tierOrder`; a tier the catalogue does not name goes last.
 */
export const APPLICATION_MAP = {
  tierOrder: ['web', 'api', 'auth', 'app', 'worker', 'db', 'infra'],
  placementHops: 3,
  /** Relationships that place a component on what it runs on. */
  placementTypes: ['runs_on', 'hosted_on'],
  /** Relationships from a component that make it depend on another component or a data store. */
  dependencyTypes: ['depends_on', 'backed_by'],
  /** Components a map may show; a larger application is cut and says so. */
  maxComponents: 200,
} as const;

/**
 * REQ-CMDB-013 REQ-CMDB-016 — editing a CI by hand: tags are trimmed, de-duplicated and kept to `maxTags` of at most
 * `maxTagLength` characters drawn from `tagPattern` (letters, digits and . _ : / - in any script); the tag picker lists
 * the tenant's `tagListLimit` most used tags.
 */
export const CI_EDIT = {
  maxTags: 32,
  maxTagLength: 48,
  tagPattern: '^[\\p{L}\\p{N}][\\p{L}\\p{N}._:/-]*$',
  tagListLimit: 100,
} as const;

/**
 * REQ-CMDB-015 — tenant-defined custom fields on CIs. A key is a camelCase identifier (it is also the filter key); a
 * tenant keeps up to `maxDefinitions`; text values are capped so a field stays a field, not a document store.
 */
export const CUSTOM_FIELDS = {
  keyPattern: '^[a-z][a-zA-Z0-9_]{1,47}$',
  maxDefinitions: 200,
  maxLabelLength: 80,
  maxDescriptionLength: 400,
  maxOptions: 50,
  maxTextLength: 1_000,
} as const;

/**
 * REQ-CMDB-033 REQ-CMDB-036 (ADR-032) — imports and exports. An import is a collector result from the `import` source:
 * its observations enter at RECONCILIATION.importSeedConfidence, so they fill what discovery has not observed and
 * never overwrite it, and discovery overwrites them later. Files up to `maxFileBytes`; `previewRows` rows are shown
 * back; results are queued in chunks of `resultChunk` observations. Exports stream `exportPageSize` CIs per read.
 */
export const IMPORTS = {
  collectorId: 'import',
  nodeId: 'api',
  maxFileBytes: 10_485_760,
  /** GraphQL request body limit: the base64 of the largest file plus the mapping. */
  maxBodyBytes: 16_777_216,
  previewRows: 20,
  maxRejectedShown: 200,
  resultChunk: 2_000,
  exportPageSize: 1_000,
  maxFilenameLength: 200,
  /** Padding the base64 length check allows for line breaks some encoders insert. */
  base64Slack: 1_024,
  /** Base64 carries 3 bytes in 4 characters: the longest content string a file of maxFileBytes can become. */
  maxBase64Length: Math.ceil((10_485_760 * 4) / 3) + 1_024,
  /** Lifecycle of a CI an import creates: recorded by a person's source, not observed. */
  createdLifecycle: 'managed',
} as const;

/**
 * REQ-INT-011 (ADR-072) — dynamic inventory for configuration-management tools (Ansible, SaltStack, Puppet, Chef).
 * Every list is a default a request can override with its own query parameters.
 */
export const INVENTORY = {
  /** CI types a configuration-management tool connects to when no `types` filter is given. */
  defaultTypes: ['host', 'vm', 'hypervisor', 'network_device', 'load_balancer', 'storage_array', 'fc_switch', 'cloud_resource'],
  /** Lifecycles exported by default: planned CIs do not exist yet and retired ones are gone. */
  defaultLifecycle: ['discovered', 'managed'],
  /**
   * Where the address a tool connects to comes from, first match wins, each key read from identity then attributes.
   * The management address beats the FQDN (a device's out-of-band interface is the one automation uses); the
   * primary and guest IPs are the fallback for CIs that report neither.
   */
  addressKeys: ['managementIp', 'fqdn', 'primaryIp', 'ipAddress'],
  /** Keys whose value names the node in the tool (Ansible host, Salt minion id, Puppet certname, Chef node), first match wins, then the CI name. */
  nodeNameKeys: ['fqdn'],
  /** Attributes copied into hostvars, parameters, grains and node attributes when the request names none. */
  defaultAttributes: ['osName', 'osVersion', 'guestOs', 'guestOsFamily', 'platform', 'role', 'manufacturer', 'model', 'serialNumber', 'environment', 'owner'],
  /** Attribute carrying the site code a collector observed, used when no `located_in` chain reaches a site CI. */
  siteAttribute: 'site',
  /** Identity or attribute key holding a site CI's code. */
  siteCodeKey: 'code',
  /**
   * Edges walked from a CI towards the site that houses it: a VM runs on a hypervisor, hosted on a host, in a rack,
   * row and room of the site — six hops, plus one for a cluster in between.
   */
  siteEdges: ['located_in', 'runs_on', 'hosted_on'],
  siteHops: 7,
  /**
   * A CI belongs to a business service when the service's members (`part_of_service`) reach it through these compute
   * edges (application → component → VM → hypervisor → host). Power, cabling and network edges are left out: a
   * service depends on its PDUs, but an Ansible group of a service is the machines that run it.
   */
  serviceEdges: ['contains', 'depends_on', 'runs_on', 'hosted_on', 'backed_by'],
  /** `contains` is a compute edge only from these logical containers, as in the impact walk (ADR-019). */
  serviceContainerTypes: ['application', 'k8s_namespace', 'k8s_cluster'],
  serviceHops: 8,
  /**
   * Service membership of a tenant is reused for this long: the walk over every service takes about two seconds on the
   * 100k-CI estate, and a playbook run asks for the inventory once per run, sometimes several runs a minute.
   */
  membershipCacheMs: 60_000,
  membershipCacheEntries: 64,
  /** Puppet: the attribute naming a node's classes (an array or a comma-separated string) and its environment. */
  puppetClassesAttribute: 'puppetClasses',
  puppetEnvironmentAttribute: 'puppetEnvironment',
  /** Puppet's own default environment, used when neither the request nor the CI names one. */
  puppetDefaultEnvironment: 'production',
  /** Chef's default environment, used when neither the request nor the CI names one. */
  chefDefaultEnvironment: '_default',
  chefEnvironmentAttribute: 'chefEnvironment',
  /** Prefix of every variable, parameter, grain, role and group OpenMap writes, so they never clash with the tool's own. */
  prefix: 'openmap',
  /** Indentation of the YAML documents (Salt roster, Puppet ENC). */
  yamlIndent: 2,
  /** A YAML \uXXXX escape: four hexadecimal digits. */
  yamlEscape: { radix: 16, digits: 4 },
  /** The client scripts shipped in tools/inventory, as the console shows them. */
  clients: {
    ansibleScript: 'tools/inventory/ansible/openmap_inventory.py',
    ansiblePlugin: 'tools/inventory/ansible/plugins/inventory/openmap.py',
    saltRoster: 'tools/inventory/salt/openmap_roster.py',
    puppetEnc: 'tools/inventory/puppet/openmap_enc.py',
    chefExport: 'tools/inventory/chef/openmap_chef_export.py',
  },
} as const;

/** Byte volumes in the console (observed traffic, evidence sizes): binary units to one decimal. */
export const BYTES = {
  perUnit: 1024,
  units: ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'],
  decimals: 1,
} as const;

/** Geometry helpers for the console's scene code: the divisor that halves an extent and the tuple axis indices. */
export const GEOMETRY = {
  halfDivisor: 2,
  axisX: 0,
  axisY: 1,
  axisZ: 2,
} as const;

/**
 * 3D digital twin (apps/console, REQ-UI-029, ADR-018). World units are metres: a 42U rack is 0.6 m wide, 1.2 m deep
 * and 42 × 44.45 mm tall, so the scene reads at true proportions. The dependency layers float above the tallest rack
 * as stacked planes in CI_LAYERS order; graph positions from the 2D layouts are scaled into metres on each plane.
 */
export const TWIN = {
  /** REQ-UI-037: camera radius (metres) when a rack is open: a 42U rack (about 1.9 m) with its neighbours in frame. */
  rackFocusRadiusM: 3,
  rackWidthM: 0.6,
  rackDepthM: 1.2,
  unitHeightM: 0.04445,
  /** Gap between racks in a row and between rows (cold aisle). */
  rackGapM: 0.1,
  rowGapM: 1.8,
  /** Room slab: padding around its racks, height of the glass slab, distance between rooms, rooms per grid row. */
  roomPaddingM: 1.5,
  roomSlabHeightM: 0.08,
  roomGapM: 5,
  roomsPerRow: 3,
  /** A device plate sits inset from the rack faces and is a touch shorter than its units so slots read as separate. */
  deviceInsetM: 0.05,
  deviceHeightShare: 0.82,
  /** Layer planes: first plane above the ground, spacing, extent and translucency. */
  planeStartHeightM: 5,
  planeGapM: 1.6,
  planeSizeM: 30,
  planeOpacity: 0.07,
  planeEdgeOpacity: 0.45,
  /** Quarter turn that lays a plane geometry flat (radians). */
  planeRotationRad: -Math.PI / 2,
  /** Nodes on a plane sit on a square grid at this pitch, the root at the centre; the plane grows to fit plus a margin. */
  nodeSpacingM: 0.9,
  planeMarginM: 2,
  /** Edges on a path to a business service are drawn thick (one object each) up to this many; the rest share one batch. */
  maxPathLines: 300,
  nodeRadiusM: 0.22,
  rootNodeRadiusM: 0.42,
  /** Node radius shrinks per hop like the 2D map, down to this share of the base radius. */
  nodeRadiusStep: 0.12,
  nodeRadiusMinShare: 0.45,
  /** Sphere tessellation: enough for a smooth node at the sizes shown, cheap enough for hundreds of instances. */
  sphereSegments: 20,
  edgeWidthPx: 1.2,
  pathEdgeWidthPx: 2.4,
  edgeOpacity: 0.75,
  /** Camera: field of view in degrees, start position as multiples of the scene radius, orbit limits in metres. */
  cameraFov: 42,
  cameraNearM: 0.1,
  cameraFarM: 600,
  cameraStartRadiusShare: 1.6,
  cameraStartElevationShare: 0.8,
  cameraMinDistanceM: 2,
  cameraMaxDistanceM: 220,
  dampingFactor: 0.08,
  /** Device pixel ratio ceiling; above it the fill cost grows faster than the visible gain. */
  dprMax: 1.5,
  /** Lighting. */
  ambientIntensity: 0.55,
  keyLightIntensity: 1.3,
  keyLightPosition: [18, 28, 12] as const,
  rimLightIntensity: 0.6,
  rimLightPosition: [-16, 10, -14] as const,
  /** Emissive share for lit surfaces (racks under load, nodes), and the softer glow of rooms and device plates. */
  emissiveShare: 0.55,
  softEmissiveShare: 0.28,
  selectedEmissiveShare: 1,
  /** Rack load thresholds (percent of rated power) that change its colour. */
  loadWarnPercent: 70,
  loadHotPercent: 90,
  /** Opacity of the room slab and the rack shell. */
  roomOpacity: 0.22,
  rackOpacity: 0.55,
  /** Ground grid: cell size, section size and fade distance in metres. */
  gridCellM: 1,
  gridSectionM: 5,
  gridFadeDistanceM: 160,
  /** Characters of a label shown in the scene before it is cut. */
  labelMaxChars: 24,
  /** Height above a rack or node at which its floating label sits. */
  labelOffsetM: 0.5,
  /** Instances rendered at most; the synthetic estate has 101 racks and 2,000 devices, a 10k-device site fits. */
  maxRacks: 4_000,
  maxDevices: 60_000,
  /** Graphs above this many nodes are laid out in the worker like the 2D map. */
  workerMinNodes: 200,
} as const;

/**
 * Dependency map geometry and interaction (apps/console, REQ-UI-007, REQ-DEP-005). Graph units are Sigma's
 * abstract coordinates; the camera fits them to the viewport. Lanes are the twelve CI_LAYERS in contract order,
 * bottom (facilities) to top (applications), so y grows with the layer index.
 */
export const DEPENDENCY_MAP = {
  /** Vertical distance between lane centre lines, graph units. */
  laneHeight: 120,
  /** Horizontal distance between neighbouring nodes in one lane, graph units. */
  nodeSpacing: 60,
  /** Nodes in a lane are centred on the root's x; the divisor halves the lane width to find the start. */
  laneCentreDivisor: 2,
  /** Root (focus) node radius in px; every extra hop shrinks a node by nodeSizeStep down to minNodeSize. */
  rootNodeSize: 18,
  nodeSizeStep: 2,
  minNodeSize: 6,
  /** Edge thickness in px, and the thickness of edges on an impact path to a service. */
  edgeSize: 1.5,
  pathEdgeSize: 3,
  /** Label font size in px and the rendered node size under which labels are not drawn. */
  labelSize: 12,
  labelRenderedSizeThreshold: 8,
  /** Camera zoom limits as ratios of the fitted view, and the zoom animation length. */
  cameraMinRatio: 0.05,
  cameraMaxRatio: 4,
  zoomDurationMs: 200,
  /** Distance in px from the pointer at which the hover tooltip is anchored. */
  tooltipOffsetPx: 12,
  /** Graphs smaller than this are laid out synchronously; larger ones go to the layout Web Worker. */
  workerMinNodes: 200,
  /** Relationships fetched for the selected CI to type-colour its edges. */
  selectedRelationshipsLimit: 100,
  /**
   * Force layout (Fruchterman-Reingold, deterministic, seeded from the lane positions). It is O(n^2) per iteration,
   * so it is offered up to forceMaxNodes; larger graphs stay in lanes, which are O(n log n).
   */
  forceMaxNodes: 2_500,
  forceIterations: 150,
  /** Ideal edge length in graph units; repulsion scales with its square, attraction with its inverse. */
  forceIdealDistance: 70,
  /** Largest move per node on the first iteration, shrinking by forceCooling each iteration. */
  forceInitialStep: 40,
  forceCooling: 0.95,
  /** Two nodes closer than this are pushed apart as if at this distance, so coincident seeds do not explode. */
  forceMinDistance: 0.5,
} as const;

/**
 * Translucency steps the console applies to design-token accents (0..1). The design system's own glow alphas live in
 * @openmap/ui; these are the screen-level tints the Obsidian Pro canvas uses for backdrops, guides and tinted panels.
 */
export const CONSOLE_ALPHA = {
  /** Label backdrop over the WebGL canvas: readable text, map still visible underneath. */
  labelBackdrop: 0.9,
  /** Edges that bridge a hidden layer are drawn fainter than direct edges. */
  bridgedEdge: 0.45,
  /** Lane label chips and guide lines on the map. */
  laneTint: 0.18,
  /** Blast-radius panel background and border. */
  panelTint: 0.14,
  panelBorder: 0.3,
  /** Nodes outside an isolated blast radius on the map. */
  dimmedNode: 0.12,
  /** REQ-DCIM-003: a rack tile on the floor plan, tinted by its heat band; strong enough to read across a room. */
  heatTile: 0.35,
} as const;

/** Console-wide interaction constants shared by several screens (REQ-UI-003). */
/** Dashboards (REQ-UI-030, ADR-020): the widget grid, template sizes and the trend window every dashboard shares. */
export const DASHBOARD = {
  /** REQ-UI-036: months the uptime tile compares (this month against last). */
  uptimeMonths: 2,
  /** Decimal scale of the uptime tile's delta in percentage points (two decimals). */
  uptimeDeltaScale: 100,
  /** Widget grid columns on a wide screen; a widget spans 1..columns of them. */
  columns: 4,
  /** Widgets a dashboard may hold; the wizard and the API both refuse more. */
  maxWidgets: 24,
  /** Dashboards one user may own per tenant. */
  maxPerOwner: 20,
  nameMaxChars: 80,
  /** Days of history behind the trend sparklines and the deltas. */
  trendDays: 14,
  /** The short range a trend widget can switch to. */
  trendShortDays: 7,
  /** Rows a list widget shows before linking to its screen. */
  listRows: 6,
  /** Warranty and support horizon the finance and admin widgets default to, days. */
  horizonDays: 90,
  /** Licence renewals within this window count as "expiring", days. */
  licenceExpiryDays: 60,
  /** Sparkline height in px inside a KPI tile. */
  sparklineHeightPx: 36,
  /** Polling interval for a dashboard's live widgets in milliseconds. */
  refreshMs: 30_000,
  /** Upper bound on rows the estate aggregate reads from a list service (software products). */
  statsRowCap: 10_000,
} as const;

/**
 * The Layers stack (REQ-UI-033, ADR-021): twelve planes in contract order under a three-quarter orthographic camera;
 * click a plane to focus it, when its equipment (schematic, from primitives at plausible proportions: a 42U cabinet
 * is 0.6 × 2 × 1 m, a 2U server 0.45 × 0.09 × 0.75 m) stands on it. Scene units are metres.
 */
export const LAYER_STACK = {
  halfDivisor: 2,
  /** Plane footprint, thickness and the vertical step between planes. */
  planeWidthM: 4.0,
  planeDepthM: 2.6,
  planeThicknessM: 0.08,
  stepM: 0.64,
  /** Accent strip along a plane's front edge, in the layer colour, and the rest alpha of its edges. */
  edgeStripM: 0.05,
  edgeOpacity: 0.45,
  /** Overview camera: offset from the stack's middle and the orthographic zoom (px per metre). */
  overviewOffset: [9, 6, 9] as const,
  overviewZoom: 50,
  /** Focus camera: offset from the focused plane, zoom, how far above the plane the view centres, and the ease. */
  focusOffset: [4.2, 3.6, 4.2] as const,
  focusZoom: 140,
  focusLiftM: 0.35,
  focusMs: 380,
  /** Planes below the focused one recede to this opacity; planes above it step out of the view. */
  recededOpacity: 0.14,
  cameraNearM: 0.1,
  cameraFarM: 200,
  /** Orbit limits keep the three-quarter reading: azimuth in radians around the start, polar between the two. */
  orbitAzimuthRad: 0.6,
  orbitPolarMinRad: 0.55,
  orbitPolarMaxRad: 1.25,
  /** Lighting. */
  hemisphereIntensity: 1.9,
  keyLightIntensity: 2.6,
  keyLightPosition: [10, 18, 8] as const,
  fillLightIntensity: 0.5,
  fillLightPosition: [-12, 8, -6] as const,
  shadowMapSize: 2048,
  /** Materials: graphite chassis, darker bezels, platform slate. */
  chassisMetalness: 0.3,
  chassisRoughness: 0.5,
  bezelRoughness: 0.7,
  platformRoughness: 0.9,
  platformMetalness: 0.05,
  /** Treatment of a hidden layer and a hovered one. */
  hiddenOpacity: 0.22,
  /** Translucent parts: VM cards, zone slabs. */
  glassOpacity: 0.38,
  hoverEmissive: 0.28,
  restEmissive: 0.04,
  /** LED indicators: radius and glow strength. */
  ledRadiusM: 0.014,
  ledEmissive: 2.2,
  /** Equipment proportions, metres: cabinet, 2U server, switch, firewall, disk shelf, SAN switch, database drum. */
  cabinet: { widthM: 0.52, heightM: 1.05, depthM: 0.7, railInsetM: 0.035, panelM: 0.03, servers: 4 },
  server: { widthM: 1.1, heightM: 0.14, depthM: 0.8, bays: 8, bayInsetM: 0.012, gapM: 0.04 },
  switch: {
    widthM: 1.35,
    heightM: 0.1,
    depthM: 0.6,
    portsPerRow: 16,
    portRows: 2,
    portSizeM: 0.04,
    portGapM: 0.012,
  },
  firewall: { widthM: 0.8, heightM: 0.14, depthM: 0.6, stripeM: 0.025 },
  shelf: { widthM: 1.3, heightM: 0.22, depthM: 0.8, slots: 12, slotInsetM: 0.012 },
  sanSwitch: { widthM: 1.0, heightM: 0.08, depthM: 0.55 },
  drum: { radiusM: 0.3, heightM: 0.24, count: 3, gapM: 0.08 },
  vmCard: { widthM: 0.34, heightM: 0.05, depthM: 0.26, columns: 3, rows: 2, liftM: 0.18, gapM: 0.08 },
  container: { widthM: 0.42, heightM: 0.2, depthM: 0.22, columns: 3, rows: 2, gapM: 0.05 },
  zone: { widthM: 1.1, heightM: 0.12, depthM: 0.8, count: 3, gapM: 0.25 },
  screen: { widthM: 1.2, heightM: 0.7, depthM: 0.04, standM: 0.2 },
  crate: { sizeM: 0.8 },
  /** Units of equipment repeated for a focused layer: one at the smallest share, up to this many at the largest. */
  maxUnits: 2,
  unitGapM: 0.25,
  /** Equipment is drawn at life size on the focused plane. */
  equipmentScale: 1,
  dprMax: 1.5,
  curveSegments: 28,
} as const;

export const CONSOLE = {
  /** Keystroke-to-request delay for incremental search boxes; one request per pause, not per key. */
  searchDebounceMs: 250,
  /** Hits shown in an incremental search dropdown. */
  searchResultLimit: 12,
  /** Rows in a component explorer or picker list before the user must narrow the search. */
  explorerPageSize: 50,
  /** Relationships loaded per CI detail page before "load more". */
  relationshipsPageSize: 100,
  /** Recent discovery jobs shown on the discovery screen. */
  discoveryJobsLimit: 50,
  /** Polling interval for live screens (discovery sweep, service health) in milliseconds. */
  livePollMs: 10_000,
  /** Characters of a UUID shown when a code is not available. */
  shortIdLength: 8,
} as const;

/**
 * Browser sign-in (REQ-SEC-001, REQ-SEC-009): OIDC Authorization Code flow with PKCE against the Keycloak realm.
 * Lengths follow RFC 7636 (verifier 43–128 characters: 48 random bytes encode to 64) and the OIDC Core
 * recommendations for state and nonce entropy. Hosts and client ids live in @openmap/config, not here.
 */
export const AUTH = {
  pkceVerifierBytes: 48,
  stateBytes: 16,
  nonceBytes: 16,
  /** PKCE transform; the only method the realm client accepts (`pkce.code.challenge.method`). */
  challengeMethod: 'S256',
  challengeHash: 'SHA-256',
  /** `openid` is mandatory; `profile` and `email` supply preferred_username, name and email for the user menu. */
  scope: 'openid profile email',
  /** Access tokens are renewed this long before `exp` so no request is sent with a token about to expire. */
  refreshLeadMs: 30_000,
  /** Lower bound on the renewal timer, so a token already inside the lead window does not renew in a tight loop. */
  minRefreshDelayMs: 5_000,
  /** Base64 encodes three bytes as four characters; base64url decoding pads back to this block length. */
  base64BlockLength: 4,
  /** Segments of a compact JWS: header.payload.signature. */
  jwtSegments: 3,
  /** Default token lifetime assumed when the token endpoint omits `expires_in` (the realm issues 900 s tokens). */
  fallbackExpiresInSeconds: 300,
  /** Relative path of the OIDC discovery document under the realm URL (RFC 8414). */
  discoveryPath: '.well-known/openid-configuration',
  /** Console route, under the locale segment, that the identity provider redirects back to. */
  callbackPath: '/auth/callback',
  /** sessionStorage keys: the refresh token (survives a reload, never shared across tabs) and the pending request. */
  storageKeys: { refresh: 'openmap.auth.refresh', pending: 'openmap.auth.pending' },
  /** OIDC error codes returned on the callback that mean the user declined rather than that something broke. */
  deniedErrorCodes: ['access_denied', 'login_required', 'consent_required', 'interaction_required'] as const,
} as const;

/**
 * Realm roles the Keycloak realm import (deploy/compose/keycloak/realm-openmap.json) defines, shared by the API's
 * role guard (REQ-CORE-012) and the console's action gating (REQ-SEC-001). `node` is the Discovery Node service
 * identity and grants no console access; `automation` is the service-account client for API tokens (REQ-SEC-009).
 */
export const ROLES = {
  admin: 'openmap-admin',
  operator: 'openmap-operator',
  analyst: 'openmap-analyst',
  auditor: 'openmap-auditor',
  node: 'openmap-node',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/** Granting a role grants every role listed here: admin implies operator, operator implies analyst, auditor implies analyst. */
export const ROLE_IMPLICATIONS: Record<Role, readonly Role[]> = {
  [ROLES.admin]: [ROLES.admin, ROLES.operator, ROLES.analyst, ROLES.auditor],
  [ROLES.operator]: [ROLES.operator, ROLES.analyst],
  [ROLES.analyst]: [ROLES.analyst],
  [ROLES.auditor]: [ROLES.auditor, ROLES.analyst],
  [ROLES.node]: [ROLES.node],
};

/** Synthetic estate sizing from CLAUDE.md §8, used by tools/synth-estate and perf tests. */
export const SYNTH_ESTATE = {
  totalCis: 100_000,
  networkDevices: 5_000,
  hosts: 40_000,
  vms: 30_000,
  k8sServices: 200,
  businessServices: 300,
} as const;

/** Supported locales. Arabic is RTL; both are mandatory from the first commit (CLAUDE.md §1.8). */
export const LOCALES = ['en', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];
export const RTL_LOCALES: readonly Locale[] = ['ar'];

/**
 * Tokens that tools/guard forbids in apps/ and packages/ outside tests (CLAUDE.md §7).
 * Matched case-insensitively as whole words.
 */
export const GUARD_FORBIDDEN_TOKENS = [
  'TODO',
  'FIXME',
  'XXX',
  'HACK',
  'coming soon',
  'not implemented',
  'placeholder',
  'lorem',
  'dummy',
  'mock',
  'sample data',
  'hardcoded',
] as const;

/**
 * IPv4 literals the guard accepts anywhere: protocol constants, not deployment addresses.
 * Wildcard bind, loopback and the all-ones mask never differ between deployments.
 */
export const GUARD_ALLOWED_IPV4 = ['0.0.0.0', '127.0.0.1', '255.255.255.255'] as const;

/**
 * Paths the guard treats as configuration boundaries where literal defaults are allowed:
 * the TypeScript config package and the Go Discovery Node's equivalent module.
 */
export const GUARD_CONFIG_BOUNDARIES = ['packages/config/', 'apps/node/internal/config/'] as const;

/** Numeric literals permitted in apps/ outside @openmap/constants (CLAUDE.md §7). */
export const GUARD_ALLOWED_NUMERIC_LITERALS = [0, 1, -1] as const;

/** Lines of a source file inspected for a REQ- header (CLAUDE.md §7). Ten covers a licence banner plus a doc comment. */
export const GUARD_HEADER_LINES = 10;

/** Contract names frozen in docs/CONTRACTS.md (CLAUDE.md §2 row 7). */
export const CONTRACT_NAMES = ['ci', 'collector', 'graphql', 'event', 'rest'] as const;
export type ContractName = (typeof CONTRACT_NAMES)[number];

/** Current contract versions. Bumping one requires an ADR and a tracker row. */
export const CONTRACT_VERSIONS: Record<ContractName, string> = {
  /**
   * 0.2.0 (ADR-016): metric samples, HEALTH_STATES and the ClickHouse metric name per layer headline.
   * 0.3.0 (REQ-CMDB-014, ADR-037): `component.ts`, the `components` part list on an observed CI.
   * 0.4.0 (REQ-CMDB-034): `utilisation.ts`, the CPU, memory, disk and power metric names per CI type.
   * 0.5.0 (REQ-CMDB-023, REQ-CMDB-025, ADR-039): `lifecycle.ts`, catalogue entries, support states, OS and platform releases.
   * 0.6.0 (REQ-CMDB-024, ADR-043): `endOfLifeFromAttributes`; asset fields carry the vendor-reported end of life, the
   * warranty start and verification instant.
   * 0.7.0 (REQ-CORE-013, ADR-045): `GLOBAL_IDENTITY_SCOPES`, `IDENTITY_REF_TARGETS`, `IDENTITY_REF_ALIAS_ATTRIBUTES`,
   * `IDENTITY_REF_DERIVED` and `identity.ts`: issuer-scoped global keys and `*Ref` resolution. No payload shape changed.
   * 0.8.0 (REQ-BSM-007, ADR-025): `connectivity.ts`, the link probe metric names, site DR roles and readiness rules.
   * 0.9.0 (REQ-DCIM-001, ADR-056): the `circuit` CI type (identity circuitId + provider) and `cabling.ts`: cable kinds,
   * media, panel connectors and sides, circuit kinds and statuses, endpoint validation and the cable trace.
   * 0.10.0 (REQ-IPAM-005, ADR-064): the `firewall_object` CI type (identity deviceRef + objectId) and `firewall.ts`:
   * rule and object attributes, address and service matching, rule evaluation, shadowed and unused rules.
   */
  // 0.11.0 (REQ-IPAM-005, ADR-064 consequences): the `references` relationship type (not an impact edge).
  // 0.12.0 (REQ-SEC-011, ADR-067 step 4): custom-field contract 0.2.0, `sensitive` text fields stored encrypted; a
  // text value may not start with the Transit ciphertext prefix.
  // 0.14.0 (REQ-INT-017, ADR-075): the `backup_policy` CI type (identity vendor + serverId + policyId) and `protection.ts`:
  // policy and cover attributes, the backup job options and inventory, and the protection judgement.
  ci: '0.14.0',
  /** 0.2.0 (ADR-016): optional `samples` on a collector result. 0.3.0 (ADR-037): observed CIs may carry `components`.
   * 0.4.0 (REQ-CMDB-034): utilisation samples under the `utilisation.ts` metric names.
   * 0.5.0 (ADR-039): moves with the CI contract (observed CIs and results share its JSON Schema version).
   * 0.6.0 (REQ-CMDB-024, ADR-043): the `warranty` collector family.
   * 0.7.0 (REQ-CORE-013, ADR-045): moves with the CI contract's identity rules; no result field changed.
   * 0.8.0 (REQ-BSM-007, ADR-025): the `link_probe` family.
   * 0.9.0 (REQ-DCIM-001, ADR-056): moves with the CI contract (the `circuit` CI type); no result field changed.
   * 0.10.0 (REQ-IPAM-005, ADR-064): moves with the CI contract (the `firewall_object` CI type); no result field changed. */
  // 0.11.0: moves with the CI contract (the `references` relationship type); no result field changed.
  // 0.14.0 (REQ-INT-017, ADR-075): the `backup` family; moves with the CI contract (the `backup_policy` CI type).
  collector: '0.14.0',
  /**
   * 1.1.0 (ADR-024): `Sla`, `AvailabilityPeriod`, `ServiceAvailability`, `Rca`, `IncidentEvent`, the SLA and
   * incident-response mutations; `ServiceHealth.sla`/`availability`, `Incident` severity, state, targets and RCA.
   * 1.2.0 (REQ-CMDB-041): `AssetPage`, `assetPage` (page numbers and totals for the register).
   * 1.3.0 (REQ-CMDB-042, ADR-027): `SubscriptionCover`, `Credits`, `SubscriptionInput`, `AssetDataGap.subscription`,
   * `AssetRecord.subscription`/`subscriptionEndsAt`/`creditsRemaining`, `AssetSummary.subscriptionExpired`.
   * 1.4.0 (REQ-AI-007, ADR-028): `AssistantIntent`, `AssistantStore`, `AssistantFigure`, `AssistantEvidence`,
   * `AssistantOption`, `AssistantClarification`; `AssistantAnswer.intent`/`confidence`/`figures`/`evidence`/
   * `followUps`/`clarification`/`grounded`; `askAssistant(question, locale)`.
   * 1.5.0 (REQ-AI-008, ADR-028): `Conversation`, `AssistantTurn`, `AssistantAnswer.conversationId`/`turnId`,
   * queries `conversations`, `conversation`, mutation `deleteConversation`, `askAssistant(…, conversationId)`.
   * 1.6.0 (REQ-DEP-001, ADR-030): `TopologyLayer`, `TopologyNode`, `TopologyLink`, `NetworkTopology`,
   * query `networkTopology(layer, siteId, includeHosts)`.
   * 1.7.0 (REQ-DEP-004, ADR-031): `ApplicationMap`, `ApplicationTier`, `ApplicationComponent`, `Placement`,
   * `ApplicationDependency`, query `applicationMap(id)`.
   * 1.8.0 (REQ-CMDB-013, REQ-CMDB-016): `TagCount`, query `ciTags`, mutations `setCiLifecycle`, `setCiTags`.
   * 1.9.0 (REQ-CMDB-015): `CustomFieldType`, `CustomFieldDefinition`, `CustomFieldDefinitionInput`, `Ci.customFields`,
   * `CiFilter.customFields`, query `customFieldDefinitions`, mutations `upsertCustomFieldDefinition`,
   * `deleteCustomFieldDefinition`, `setCiCustomFields`.
   * 1.10.0 (REQ-CMDB-033, REQ-CMDB-036, ADR-032): `ImportFormat`, `ImportInput`, `ImportPreview`, `RejectedRow`,
   * `ImportJob`, query `importJobs`, mutations `previewImport`, `runImport`.
   * 1.11.0 (REQ-CMDB-017, REQ-CMDB-019, ADR-033): `Depreciation`, `DepreciationInput`, `Stock`, `StockInput`,
   * `AssetRecord.depreciation`/`bookValue`/`stock`, `AssetFilter.belowReorderPoint`, `AssetSummary.belowReorderPoint`.
   * 1.12.0 (REQ-CMDB-020, ADR-034): `PlanReceipt`, `ReceiptInput`, `ReceivedUnitInput`, `InfraPlan.description`/
   * `owner`/`receipts`, `BomLine.position`/`outstanding`, mutation `receivePlanLine`.
   * 1.13.0 (REQ-CMDB-026..029, ADR-035): `ContractKind`, `CostCentreKind`, `ContractDocument`, `Contract`, `Vendor`,
   * `VendorDetail`, `CostCentre`, `VendorContact.availability`/`escalationLevel`, `AssetRecord.ownerCostCentre`,
   * `AssetDetailsInput.ownerCostCentreId`, queries `contracts`, `contract`, `vendors`, `vendor`, `costCentres`,
   * mutations `upsertContract`, `upsertVendor`, `upsertCostCentre`, `upsertVendorContact`, `deleteVendorContact`,
   * `setAssetContract`.
   * 1.14.0 (REQ-CMDB-032, ADR-036): `Certificate`, `CertificateEndpoint`, `CertificateFilter`, query `certificates`.
   * 1.15.0 (REQ-CMDB-014, ADR-037): `ComponentKind`, `HardwareComponent`, `ComponentModelCount`, `ComponentPage`,
   * `ComponentFilter`, `Ci.components`, query `components`.
   * 1.16.0 (REQ-CMDB-034): `UtilisationMeasure`, `UtilisationState`, `UtilisationSort`, `UtilisationPoint`,
   * `UtilisationSeries`, `CiUtilisation`, `UtilisationRow`, `UtilisationPage`, `UtilisationFilter`, `Ci.utilisation`, query
   * `utilisation`.
   * 1.17.0 (REQ-CMDB-023, REQ-CMDB-025, ADR-039): `LifecycleKind`, `LifecycleState`, `LifecycleEntry`, `LifecycleRelease`,
   * `LifecycleReleasePage`, `LifecycleHardware`, `LifecycleCatalogue`, `LifecycleCatalogueSource`, `LifecycleSyncResult`, the
   * filters, queries `lifecycleReleases`, `lifecycleHardware`, `lifecycleCatalogue`, mutation `syncLifecycleCatalogue`.
   * 1.18.0 (REQ-CMDB-022): `SaasSubscriptionState`, `SaasDataFlow`, `SaasSubscription`, `SaasTenant`, `SaasInventory`, query
   * `saasInventory`.
   * 1.19.0 (REQ-BSM-004, ADR-047): `ImpactScenario.origin`, `ImpactValidation`, `ImpactAccuracy`, `RelationshipSuggestion`,
   * queries `impactAccuracy`, `relationshipSuggestions`, mutations `validateImpactPredictions`, `validateImpactPrediction`,
   * `acceptRelationshipSuggestion`, `dismissRelationshipSuggestion`.
   * 1.20.0 (REQ-BSM-005, ADR-048): `Runbook`, `RunbookStep`, `RunbookAutomation`, `RunbookStepRun`, the runbook inputs,
   * `ScenarioInput.runbookId`, `ImpactScenario.runbook`, `Incident.runbook`/`suggestedRunbook`/`runbookRuns`/
   * `recoveryEstimateMinutes`/`recoveryRemainingMinutes`, queries `runbooks`, `runbook`, mutations `upsertRunbook`,
   * `deleteRunbook`, `setScenarioRunbook`, `setIncidentRunbook`, `runRunbookStep`.
   * 1.21.0 (REQ-BSM-007, ADR-025): `Connectivity`, `ConnectivitySite`, `ConnectivityLink`, `ReadinessFinding`, query
   * `connectivity`; `Site.drRole`/`criticality`, `SiteLink.replication`/`probeTarget` and the same on their inputs.
   * 1.29.0 (REQ-DCIM-001, ADR-056): `CableKind`, `CableMedia`, `PanelConnector`, `PanelSide`, `CircuitKind`,
   * `CircuitStatus`, `CableEndpoint`, `Cable`, `PatchPanelPort`, `PatchPanel`, `Circuit`, `CablingSummary`, `Cabling`,
   * `CableHop`, `CableTrace` and their inputs, queries `cabling`, `cableTrace`, mutations `upsertPatchPanel`,
   * `removePatchPanel`, `connectCable`, `disconnectCable`, `upsertCircuit`, `removeCircuit`.
   * 1.30.0 (REQ-DCIM-003, ADR-057): mutation `placeRack(rackId, rowId, position)`.
   * 1.31.0 (REQ-DCIM-004, ADR-058): `PowerSourceKind`, `PowerFindingKind`, `PowerSource`, `PowerFinding`,
   * `PowerChainSummary`, `PowerChain`, `PowerConnection`, `PowerConnectionInput`, queries `powerChain`, `pduConnections`,
   * mutations `connectPower`, `disconnectPower`.
   * 1.32.0 (REQ-DCIM-005, ADR-059): `PowerState`, `PowerSettings`, `PowerSettingsInput`, `PowerReading`, `PduMonitor`,
   * `OutletBill`, `DeviceBill`, `PowerMonitor`, queries `powerSettings`, `powerMonitor`, mutation `updatePowerSettings`.
   * 1.33.0 (REQ-DCIM-006, ADR-060): `EnvState`, `EnvReading`, `RackEnvironment`, `CoolingEnvironment`, `EnvSummary`,
   * `RoomEnvironment`, query `roomEnvironment`.
   * 1.34.0 (REQ-DCIM-007, ADR-061): `CapacityState`, `SpaceCapacity`, `PowerCapacity`, `PortCapacity`,
   * `CoolingCapacity`, `CapacityTrend`, `RackCapacity`, `RoomCapacity`, query `roomCapacity`.
   * 1.35.0 (REQ-DCIM-008, ADR-062): `CableVerificationStatus`, `CableVerificationReason`, `ObservedPort`,
   * `ObservedLink`, `CableVerification`, `CablingVerificationSummary`, `CablingVerification`; queries
   * `cablingVerification`, `cablingLabelsCsv`.
   * 1.36.0 (REQ-IPAM-004, ADR-063): `PortState`, `LearnedMac`, `PortNeighbour`, `SwitchPort`, `SwitchPortSummary`,
   * `SwitchPorts`, `PortChange`, `PortHistory`, `MacSightingKind`, `MacSighting`, `MacLookup`; queries `switchPorts`,
   * `portHistory`, `macLookup`.
   * 1.37.0 (REQ-IPAM-005, ADR-064): `FirewallAction`, `FirewallVerdict`, `FirewallFindingKind`, `FirewallObjectKind`,
   * `FirewallFinding`, `FirewallRule`, `FirewallObject`, `FirewallChain`, `FirewallSummary`, `FirewallPolicy`,
   * `FirewallDevice`, `FirewallCheckInput`, `FirewallCheckResult`, `FirewallCheck`; queries `firewallDevices`,
   * `firewallPolicy`, `firewallCheck`.
   * 1.38.0 (REQ-INT-009, ADR-065): mutation `sendTestNotification`.
   * 1.39.0 (REQ-INT-019, ADR-066): `BackupState`, `BackupSet`, `Backups`, query `backups`.
   * 1.40.0 (REQ-SEC-011, ADR-067 steps 4-5): `CustomFieldDefinition.sensitive`, `CustomFieldDefinitionInput.sensitive`,
   * `BackupSet.encrypted`.
   * 1.41.0 (REQ-IPAM-007, ADR-069): `LinkSharedRiskKind`, `LinkSharedRisk`, `LinkCircuit`, `LinkCircuitInput`,
   * `ConnectivityLink.carrierContractRef`/`pathRef`/`circuits`/`sharedRisks`, `SiteLink.carrierContractRef`/
   * `slaLatencyMs`/`pathRef` and the same on `SiteLinkInput`, mutation `saveLinkCircuit`.
   * 1.42.0 (REQ-SEC-012, ADR-070): `ComplianceFramework`, `ComplianceCheck`, `ComplianceResult`, `ComplianceFact`,
   * `ComplianceTally`, `ComplianceControlPosture`, `ComplianceFrameworkPosture`, `ComplianceCveRisk`, `ComplianceRun`,
   * `CompliancePosture`, `ComplianceFinding`, `ComplianceControlDetail`; queries `compliancePosture`,
   * `complianceControl`; mutation `evaluateCompliance`.
   * 1.43.0 (REQ-PERF-005, ADR-071): `PlatformHealth` and its parts (`PrometheusStatus`, `PlatformTarget`,
   * `PlatformStoreHealth`, `PlatformQueue`, `PlatformSli`, `PlatformAlert`, `PerfBudgetCheck`), query `platformHealth`.
   * 1.45.0 (REQ-INT-012, ADR-073): `MonitoringAlertStatus`, `MonitoringTarget`, `MonitoringAlert`,
   * `MonitoringSourceMapping`, `MonitoringAlerts`; query `monitoringAlerts`; mutations `mapMonitoringSource`,
   * `clearMonitoringAlert`.
   * 1.46.0: the 1.41.0 additions of REQ-IPAM-007 (ADR-069), released after 1.45.0 because they merged later.
   * 1.47.0 (REQ-INT-016, ADR-074; allocated as 1.46.0, merged after REQ-IPAM-007): `IdentitySourceKind`, `IdentitySourceVendor`, `IdentitySourceState`,
   * `IdentityMappedRole`, `IdentityRoleMapping`, `LdapSourceSettings`, `OidcSourceSettings`, `IdentitySourceTest`,
   * `IdentitySourceSync`, `IdentitySource` and their inputs; query `identitySources`; mutations `upsertIdentitySource`,
   * `testIdentitySource`, `syncIdentitySource`, `removeIdentitySource`.
   * 1.48.0 (REQ-INT-017, ADR-075; allocated as 1.47.0, merged after REQ-INT-016): `ProtectionState`, `BackupCover`, `ProtectionService`, `CiProtection`,
   * `ProtectionGaps`; queries `ciProtection`, `protectionGaps`.
   */
  graphql: '1.48.0',
  /**
   * 0.4.0 (ADR-024): `openmap.bsm.sla.at_risk`. 0.5.0 (ADR-028): `openmap.assistant.query.failed`.
   * 0.6.0 (ADR-029): `openmap.dependency.derived`. 0.7.0 (REQ-CMDB-019, ADR-033): `openmap.asset.stock.low`.
   * 0.8.0 (REQ-CMDB-020, ADR-034): `openmap.plan.line.received`. 0.9.0 (REQ-CMDB-032, ADR-036): `openmap.certificate.expiring`.
   * 0.10.0 (REQ-CMDB-014, ADR-037): `openmap.component.changed`.
   * 0.11.0 (REQ-CORE-021, ADR-059 consequences): `openmap.relationship.updated`.
   * 0.12.0 (REQ-INT-009, ADR-065): `openmap.integration.notification.test`.
   */
  event: '0.12.0',
  /** 1.0.0 (REQ-CORE-019, ADR-049): REST v1 from the route table (packages/contracts/src/rest.ts) and its OpenAPI 3.1 document.
   * 1.2.0 (REQ-INT-011, ADR-072): `/inventory/ansible`, `/inventory/salt`, `/inventory/puppet`,
   * `/inventory/puppet/nodes/{certname}`, `/inventory/chef`; a route may produce YAML (`produces`). */
  rest: '1.2.0',
};
