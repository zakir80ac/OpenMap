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
  lighthouseEmbeddedPerformanceMin: 0.7,
} as const;

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
   * Relationship types that carry failure from a dependency to its dependants (traversed upstream). `contains` is
   * traversed only from the containers in `impactContainerTypes`: an application is down when its component is, a
   * switch is not down when one of its interfaces is (ADR-019).
   */
  impactEdgeTypes: ['depends_on', 'runs_on', 'hosted_on', 'powered_by', 'cooled_by', 'connected_to', 'cabled_to', 'uses_ip', 'mounted_on', 'backed_by', 'secured_by', 'part_of_service', 'contains'] as const,
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
export const BSM = {
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
  msPerDay: 86_400_000,
  microsecondsPerMillisecond: 1000,
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

/** Assistant limits: schema grounding is truncated to keep prompts inside small local models. */
/** Electrical unit conversions used by DCIM views (REQ-DCIM-001). */
export const POWER = {
  wattsPerKilowatt: 1_000,
  /** Default PDU input voltage when a collector reports amps without volts (single-phase data-centre feeds). */
  defaultInputVoltage: 230,
} as const;

/** Assets screen (REQ-UI-009): warranty and support horizons offered in the attention table, in days. */
export const ASSETS = {
  warrantyHorizonsDays: [30, 90, 180, 365] as const,
  defaultWarrantyHorizonDays: 90,
  /** Lines a new plan starts with. */
  initialBomLines: 1,
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
  schemeColors: ['#22D3EE', '#8B5CF6', '#2DD4A0', '#F5B82E', '#FB5B7A', '#38BDF8', '#A78BFA', '#F472B6', '#34D399', '#FBBF24'] as const,
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
} as const;

/** Reconciler and outbox dispatcher pacing. */
export const RECONCILER = {
  /** Outbox rows claimed per dispatcher tick; every target receives the batch in one round trip. */
  outboxBatchSize: 1_000,
  /** Idle wait between dispatcher ticks when the outbox is empty. */
  outboxIdleMs: 1_000,
  /** Candidate CIs fetched per identity lookup batch. */
  lookupBatchSize: 500,
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
   * Metric samples carried per `openmap.metric.sampled` event (ADR-016). A sweep of 10k hosts yields tens of
   * thousands of samples; chunking keeps every outbox envelope and ClickHouse insert at a few hundred kilobytes.
   */
  samplesPerEvent: 500,
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
} as const;

/** Console-wide interaction constants shared by several screens (REQ-UI-003). */
/** Dashboards (REQ-UI-030, ADR-020): the widget grid, template sizes and the trend window every dashboard shares. */
export const DASHBOARD = {
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
  switch: { widthM: 1.35, heightM: 0.1, depthM: 0.6, portsPerRow: 16, portRows: 2, portSizeM: 0.04, portGapM: 0.012 },
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
export const CONTRACT_NAMES = ['ci', 'collector', 'graphql', 'event'] as const;
export type ContractName = (typeof CONTRACT_NAMES)[number];

/** Current contract versions. Bumping one requires an ADR and a tracker row. */
export const CONTRACT_VERSIONS: Record<ContractName, string> = {
  /** 0.2.0 (ADR-016): metric samples, HEALTH_STATES and the ClickHouse metric name per layer headline. */
  ci: '0.2.0',
  /** 0.2.0 (ADR-016): optional `samples` on a collector result. */
  collector: '0.2.0',
  /** 0.10.0 (ADR-020): `Dashboard`, `EstateStats`, the dashboard queries and mutations. */
  graphql: '0.10.0',
  /** 0.2.0 (ADR-016): `openmap.metric.sampled`. */
  event: '0.2.0',
};
