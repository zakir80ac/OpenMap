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
  /** Relationship types that carry failure from a dependency to its dependants (traversed upstream). */
  impactEdgeTypes: ['depends_on', 'runs_on', 'hosted_on', 'powered_by', 'cooled_by', 'connected_to', 'cabled_to', 'uses_ip', 'mounted_on', 'backed_by', 'secured_by', 'part_of_service'] as const,
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
  /** Internal CA lifetime (ten years) and scheduler server certificate lifetime (browser-safe 825 days). */
  caValidityDays: 3650,
  serverValidityDays: 825,
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
export const ASSISTANT = {
  maxRowsReturned: 200,
  /** Names listed in a summary before "and N more". */
  summaryNames: 5,
  maxCypherLength: 4_000,
  maxQuestionLength: 2_000,
  /** Cypher execution timeout for assistant queries, milliseconds. */
  queryTimeoutMs: 15_000,
  temperature: 0.1,
} as const;

/** Reconciler and outbox dispatcher pacing. */
export const RECONCILER = {
  /** Outbox rows claimed per dispatcher tick; every target receives the batch in one round trip. */
  outboxBatchSize: 1_000,
  /** Idle wait between dispatcher ticks when the outbox is empty. */
  outboxIdleMs: 1_000,
  /** Candidate CIs fetched per identity lookup batch. */
  lookupBatchSize: 500,
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
} as const;

/** Console-wide interaction constants shared by several screens (REQ-UI-003). */
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
  ci: '0.1.0',
  collector: '0.1.0',
  graphql: '0.1.0',
  event: '0.1.0',
};
