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
