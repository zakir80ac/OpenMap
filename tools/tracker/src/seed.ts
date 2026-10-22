// REQ-CORE-007 — seeds requirements from docs/CAPABILITY-MAP.md (one row per capability) plus the
// platform rows CLAUDE.md mandates (contracts, tooling, perf budgets, security controls, deployment
// profiles, UI screens). docs/SPEC.md is read too when it exists: any markdown table row whose first
// cell starts with "REQ" is imported verbatim. Re-running init only adds rows that do not exist yet.
import { readFileSync, existsSync } from 'node:fs';
import { ID_PAD_WIDTH, PERF_BUDGETS, type Workstream } from '@openmap/constants';
import { CI_LAYERS } from '@openmap/contracts';
import type { Component, ContractRow, Decision, Requirement, Risk } from './model.js';
import { today } from './model.js';

export interface SeedRow {
  workstream: Workstream;
  capabilityArea: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  priority: 'P0' | 'P1' | 'P2';
  specSection: string;
  dependsOn?: string[];
}

interface CapabilityRow {
  section: string;
  feature: string;
  openmap: string;
  parity: string;
  workstream: Workstream;
}

const WS_SET = new Set(['CORE', 'DISC', 'DEP', 'CMDB', 'IPAM', 'DCIM', 'BSM', 'UI', 'AI', 'INT', 'QA', 'PERF', 'SEC']);

export function parseCapabilityMap(markdown: string): CapabilityRow[] {
  const rows: CapabilityRow[] = [];
  let section = '';
  for (const line of markdown.split(/\r?\n/)) {
    const h = /^##\s+(.+)$/.exec(line);
    if (h) {
      section = h[1]?.trim() ?? '';
      continue;
    }
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 4) continue;
    const ws = cells[3] ?? '';
    if (!WS_SET.has(ws)) continue;
    rows.push({ section, feature: cells[0] ?? '', openmap: cells[1] ?? '', parity: cells[2] ?? '', workstream: ws as Workstream });
  }
  return rows;
}

function stripSectionNumber(section: string): string {
  return section.replace(/^\d+\.\s*/, '');
}

function priorityFor(row: CapabilityRow): 'P0' | 'P1' | 'P2' {
  if (row.workstream === 'CORE' || row.workstream === 'DISC' || row.workstream === 'DEP' || row.workstream === 'BSM') return 'P0';
  if (row.workstream === 'INT' && /SAP|Coupa|Zendesk|Freshservice|Cherwell|Pulumi/i.test(row.feature)) return 'P2';
  return 'P1';
}

export function seedsFromCapabilityMap(markdown: string): SeedRow[] {
  return parseCapabilityMap(markdown).map((row) => ({
    workstream: row.workstream,
    capabilityArea: stripSectionNumber(row.section),
    title: row.feature.replace(/`/g, ''),
    description: 'OpenMap: ' + row.openmap.replace(/`/g, '') + ' (parity ' + row.parity + ' vs Device42)',
    acceptanceCriteria:
      'Implemented end to end against the compose stack; unit, integration and e2e tests pass; en and ar strings present; OpenTelemetry span and Prometheus metric emitted; works in the airgap profile; guard passes.',
    priority: priorityFor(row),
    specSection: 'CAPABILITY-MAP.md §' + row.section,
  }));
}

/** Rows that CLAUDE.md itself mandates and that are not product capabilities in the map. */
export function platformSeeds(): SeedRow[] {
  const core: SeedRow[] = [
    { workstream: 'CORE', capabilityArea: 'Contracts', title: 'CI contract frozen (packages/contracts/ci.ts)', description: 'CI, relationship, layer, identity keys, user label schemas with JSON Schema emission.', acceptanceCriteria: 'Schemas validate fixtures; JSON Schema emitted; docs/CONTRACTS.md v0.1.0; ADR recorded.', priority: 'P0', specSection: 'CLAUDE.md §8 Contracts first' },
    { workstream: 'CORE', capabilityArea: 'Contracts', title: 'Collector contract frozen (collector.ts)', description: 'Manifest, job, result, evidence, error schemas for every collector family.', acceptanceCriteria: 'Go and TypeScript both validate against the emitted JSON Schema; a result from the synth estate round-trips.', priority: 'P0', specSection: 'CLAUDE.md §8' },
    { workstream: 'CORE', capabilityArea: 'Configuration', title: 'Validated environment and tenant settings (packages/config)', description: 'zod-validated env with documented defaults; tenant settings schema and repository interface.', acceptanceCriteria: 'No process.env read outside packages/config; invalid env fails fast with the variable named; tests pass.', priority: 'P0', specSection: 'CLAUDE.md §1.1' },
    { workstream: 'CORE', capabilityArea: 'Configuration', title: 'Named constants with rationale (packages/constants)', description: 'Every cross-deployment constant lives here with a comment.', acceptanceCriteria: 'Guard finds no magic numbers in apps/; constants documented.', priority: 'P0', specSection: 'CLAUDE.md §1.1' },
    { workstream: 'CORE', capabilityArea: 'Contracts', title: 'Event contract frozen (event.ts)', description: 'CloudEvents envelope, event types, outbox record.', acceptanceCriteria: 'Every cross-store write emits an event; outbox delivers to Memgraph, ClickHouse, Meilisearch, WebSocket.', priority: 'P0', specSection: 'CLAUDE.md §9 NestJS outbox' },
    { workstream: 'CORE', capabilityArea: 'Contracts', title: 'GraphQL schema frozen (graphql/schema.graphql)', description: 'Queries, mutations and subscriptions for every module.', acceptanceCriteria: 'Schema parses; breaking-change check in CI; docs/CONTRACTS.md lists it.', priority: 'P0', specSection: 'CLAUDE.md §2 row 7' },
    { workstream: 'CORE', capabilityArea: 'Tooling', title: 'Tracker CLI (tools/tracker) over OpenMap-Tracker.xlsx', description: 'init, add, set, status, next, report, verify, session commands on ExcelJS.', acceptanceCriteria: 'All commands work; verify fails on Done rows without tests and evidence; Dashboard sheet regenerated.', priority: 'P0', specSection: 'CLAUDE.md §3' },
    { workstream: 'CORE', capabilityArea: 'Tooling', title: 'Guard (tools/guard) in pre-commit and CI', description: 'Forbidden tokens, any, literals, magic numbers, user-facing strings, REQ headers, tracker verify, perf budgets.', acceptanceCriteria: 'Each rule has a failing fixture test; pre-commit and CI run it.', priority: 'P0', specSection: 'CLAUDE.md §7' },
    { workstream: 'CORE', capabilityArea: 'Data', title: 'Prisma schema and migrations (packages/db)', description: 'Postgres system of record for CIs, relationships, assets, plans, tenants, outbox, integrations.', acceptanceCriteria: 'Migrations apply on a fresh compose stack; bitemporal columns on CIs and relationships.', priority: 'P0', specSection: 'CLAUDE.md §9' },
    { workstream: 'CORE', capabilityArea: 'Data', title: 'ClickHouse DDL and Memgraph schema and triggers (packages/db)', description: 'Versioned DDL for history, metrics and the graph.', acceptanceCriteria: 'Applied by the migration job; impact query under budget on the synth estate.', priority: 'P0', specSection: 'CLAUDE.md §9' },
    { workstream: 'CORE', capabilityArea: 'Graph', title: 'Cypher repository abstraction (packages/graph)', description: 'Memgraph default with a Neo4j adapter behind one interface.', acceptanceCriteria: 'Same integration tests pass against both engines.', priority: 'P1', specSection: 'CLAUDE.md §5' },
    { workstream: 'CORE', capabilityArea: 'API', title: 'NestJS on Fastify API with Mercurius GraphQL, REST and WebSocket (apps/api)', description: 'One module per bounded context, zod DTOs, repositories behind interfaces.', acceptanceCriteria: 'All GraphQL operations in the frozen schema resolve against the compose stack; OpenAPI published.', priority: 'P0', specSection: 'CLAUDE.md §5' },
    { workstream: 'CORE', capabilityArea: 'Reconciliation', title: 'Reconciler and outbox fan-out (apps/reconciler)', description: 'Identity-key matching, confidence precedence, conflict events, writes to all stores through the outbox.', acceptanceCriteria: 'Synth estate replay reconciles to the expected CI count with zero duplicates.', priority: 'P0', specSection: 'CLAUDE.md §5' },
    { workstream: 'CORE', capabilityArea: 'Observability', title: 'OpenTelemetry spans and Prometheus metrics in every service', description: 'Shared instrumentation package; metrics path from config.', acceptanceCriteria: 'Every new path has a span and a metric (DoD §6.6).', priority: 'P0', specSection: 'CLAUDE.md §6' },
    { workstream: 'CORE', capabilityArea: 'Time travel', title: 'Bitemporal CI history and time-travel reads', description: 'validFrom/validTo on CIs and relationships; ClickHouse snapshots; any screen readable as of a date.', acceptanceCriteria: 'A CI shows its past attributes and relationships for any date within retention.', priority: 'P0', specSection: 'CLAUDE.md §0' },
  ];
  const ui: SeedRow[] = [
    { workstream: 'UI', capabilityArea: 'Design system', title: 'Obsidian Pro design tokens and components (packages/ui)', description: 'Tokens from the approved design canvas; RTL-aware components; no raw colours in apps.', acceptanceCriteria: 'Every console screen uses tokens only; Storybook or equivalent renders en and ar.', priority: 'P0', specSection: 'Design canvas VcFmJuAaHCmrvgpPMmTzrf' },
    { workstream: 'UI', capabilityArea: 'i18n', title: 'en and ar catalogues with build-time parity check (packages/i18n)', description: 'Every user-facing string is a key; build fails on a missing key.', acceptanceCriteria: 'i18n:check passes; RTL screenshots attached for each screen.', priority: 'P0', specSection: 'CLAUDE.md §1.8' },
    ...[
      'App shell: sidebar, global search, time-travel control, tenant and locale switch',
      'Dashboard',
      'Layers: isometric stack, visibility toggles, label and promote unknowns',
      'Discovery: nodes, jobs, credentials, sweep progress',
      'Dependency map: Sigma.js WebGL in a worker, impact panel, layer filters',
      'CMDB list and CI detail with tabs, history timeline and evidence',
      'Assets: lifecycle, attention table, warranty horizon, vendor support, plans with BOM',
      'IPAM: subnet tree, address table, DNS and DHCP',
      'DCIM: 3D rack elevation, room heat map, power, cabling',
      'Business services: service model, SLA budget, incident timeline, cost',
      'Impact modeling: scenarios, propagation flow, affected services, actions, report and respond',
      'Integrations: catalogue, flow, per-integration detail with mappings and deliveries',
      'Software and licences',
      'Vulnerabilities',
      'Analytics: embedded Superset with tenant row-level security',
      'Assistant: chat over the graph with generated Cypher shown',
      'Settings: tenant, users and roles, audit',
      'Onboarding wizard: organization, sites, connectivity, nodes and credentials, integrations, generate digital twin',
    ].map<SeedRow>((title) => ({
      workstream: 'UI',
      capabilityArea: 'Screens',
      title: 'Screen · ' + title,
      description: 'Next.js App Router screen per the design canvas; server components by default; TanStack Query and Virtual.',
      acceptanceCriteria: 'Playwright e2e in en and ar; Lighthouse budget met; p95 interaction under ' + String(PERF_BUDGETS.screenInteractionP95Ms) + ' ms.',
      priority: 'P0',
      specSection: 'Design canvas VcFmJuAaHCmrvgpPMmTzrf',
    })),
  ];
  const perf: SeedRow[] = [
    { workstream: 'PERF', capabilityArea: 'Budgets', title: 'p95 screen interaction under ' + String(PERF_BUDGETS.screenInteractionP95Ms) + ' ms', description: 'Lighthouse and Playwright timing on every screen.', acceptanceCriteria: 'CI fails when the budget is exceeded.', priority: 'P0', specSection: 'CLAUDE.md §0' },
    { workstream: 'PERF', capabilityArea: 'Budgets', title: 'Impact query under ' + String(PERF_BUDGETS.impactQuery100kP95Ms) + ' ms on ' + String(PERF_BUDGETS.impactQueryGraphNodes) + ' nodes', description: 'k6 against the synth estate.', acceptanceCriteria: 'k6 threshold enforced in CI.', priority: 'P0', specSection: 'CLAUDE.md §0' },
    { workstream: 'PERF', capabilityArea: 'Budgets', title: 'Graph rendering at ' + String(PERF_BUDGETS.graphRenderFps) + ' fps', description: 'Sigma.js in a Web Worker with WebGL.', acceptanceCriteria: 'Playwright frame timing on the 100k estate.', priority: 'P0', specSection: 'CLAUDE.md §0' },
    { workstream: 'PERF', capabilityArea: 'Budgets', title: String(PERF_BUDGETS.discoverySweepDevices) + ' devices discovered in under ' + String(PERF_BUDGETS.discoverySweepMinutes) + ' minutes', description: 'Scheduler planning and Node concurrency.', acceptanceCriteria: 'Synth estate sweep timed in CI nightly.', priority: 'P0', specSection: 'CLAUDE.md §0' },
  ];
  const sec: SeedRow[] = [
    { workstream: 'SEC', capabilityArea: 'Identity', title: 'Keycloak OIDC with roles and attribute-based access', description: 'SSO, MFA via Keycloak, API tokens.', acceptanceCriteria: 'Every GraphQL field authorised; e2e covers denied paths.', priority: 'P0', specSection: 'CLAUDE.md §1.6' },
    { workstream: 'SEC', capabilityArea: 'Secrets', title: 'OpenBao for collector and integration credentials', description: 'Credential references only; the Node resolves them.', acceptanceCriteria: 'No secret in Postgres or logs; rotation test passes.', priority: 'P0', specSection: 'CLAUDE.md §1' },
    { workstream: 'SEC', capabilityArea: 'Sovereignty', title: 'No outbound call at runtime except collectors and tenant-enabled integrations', description: 'Egress policy test in the airgap profile.', acceptanceCriteria: 'Airgap compose passes the full e2e suite with egress blocked.', priority: 'P0', specSection: 'CLAUDE.md §1.7' },
    { workstream: 'SEC', capabilityArea: 'Transport', title: 'mTLS between Discovery Nodes and the scheduler', description: 'Node identity certificates; pull model; no inbound ports on sites.', acceptanceCriteria: 'Go tests and an integration test with a bad certificate rejected.', priority: 'P0', specSection: 'CLAUDE.md §5' },
    { workstream: 'SEC', capabilityArea: 'Audit', title: 'Immutable audit log of every change', description: 'Audit events in ClickHouse with retention.', acceptanceCriteria: 'Every mutation produces an audit event visible in Settings.', priority: 'P0', specSection: 'CLAUDE.md §6' },
  ];
  const qa: SeedRow[] = [
    { workstream: 'QA', capabilityArea: 'Synthetic estate', title: 'tools/synth-estate deterministic 100k-CI generator', description: 'Sites, racks, 5k network devices, 40k hosts, 30k VMs, 200 k8s services, 300 business services, IPAM, PDUs replayed through the collector contract.', acceptanceCriteria: 'Same seed produces identical output; replay reconciles within budget.', priority: 'P0', specSection: 'CLAUDE.md §8' },
    { workstream: 'QA', capabilityArea: 'Harness', title: 'Compose test harness (packages/testing)', description: 'Starts the real stack for integration tests; fixtures recorded from real devices.', acceptanceCriteria: 'pnpm test runs integration tests against compose in CI.', priority: 'P0', specSection: 'CLAUDE.md §8' },
    { workstream: 'QA', capabilityArea: 'Fixtures', title: 'Vendor lab fixtures for every collector family', description: 'Recorded SNMP walks, CLI outputs, API responses in packages/testing/fixtures.', acceptanceCriteria: 'Each collector family has at least one real recorded fixture; none fabricated.', priority: 'P0', specSection: 'CLAUDE.md §8' },
    { workstream: 'QA', capabilityArea: 'E2E', title: 'Playwright suite in en and ar for every screen', description: 'RTL screenshots as evidence.', acceptanceCriteria: 'Suite green in CI on the compose stack.', priority: 'P0', specSection: 'CLAUDE.md §6' },
  ];
  const int: SeedRow[] = [
    { workstream: 'INT', capabilityArea: 'Deployment', title: 'Single-node docker compose profile', description: 'Postgres, Memgraph, ClickHouse, Valkey, Meilisearch, Keycloak, OpenBao, Superset, vLLM or llama.cpp fallback.', acceptanceCriteria: 'docker compose up brings everything healthy; e2e passes.', priority: 'P0', specSection: 'CLAUDE.md §1.2' },
    { workstream: 'INT', capabilityArea: 'Deployment', title: 'Air-gapped compose profile and offline bundle', description: 'All images and models bundled; pull_policy never.', acceptanceCriteria: 'Full e2e passes with no network.', priority: 'P0', specSection: 'CLAUDE.md §1.7' },
    { workstream: 'INT', capabilityArea: 'Deployment', title: 'Helm chart', description: 'Kubernetes deployment of every service with the same configuration surface.', acceptanceCriteria: 'helm install on kind passes smoke tests.', priority: 'P1', specSection: 'CLAUDE.md §5' },
    { workstream: 'INT', capabilityArea: 'Deployment', title: 'CPU LLM fallback (llama.cpp server) documented and tested', description: 'Assistant works without a GPU.', acceptanceCriteria: 'NL to Cypher e2e passes on the CPU profile within LLM_TIMEOUT_MS.', priority: 'P1', specSection: 'CLAUDE.md §1.2' },
  ];
  const ai: SeedRow[] = [
    { workstream: 'AI', capabilityArea: 'Assistant', title: 'NL to Cypher with schema grounding and read-only execution', description: 'Local LLM; generated Cypher shown and validated before running.', acceptanceCriteria: 'Golden question set passes; no write Cypher executes.', priority: 'P0', specSection: 'CLAUDE.md §5' },
    { workstream: 'AI', capabilityArea: 'Assistant', title: 'Classification of unknown CIs and layer suggestions', description: 'Suggest type and layer from sysDescr, banners and ports; user confirms.', acceptanceCriteria: 'Suggestions shown on the Layers screen; acceptance rate tracked.', priority: 'P1', specSection: 'Layers design' },
    { workstream: 'AI', capabilityArea: 'Assistant', title: 'Anomaly rules over discovery and health events', description: 'Rule engine plus LLM explanation.', acceptanceCriteria: 'Known anomalies in the synth estate are flagged.', priority: 'P1', specSection: 'CLAUDE.md §5' },
    { workstream: 'AI', capabilityArea: 'Assistant', title: 'Recommended actions in impact modeling and incidents', description: 'Graph-grounded recommendations with rationale.', acceptanceCriteria: 'Recommendations reference real CIs and relationships only.', priority: 'P1', specSection: 'Impact design' },
  ];
  const layers: SeedRow[] = CI_LAYERS.map((layer) => ({
    workstream: 'CMDB',
    capabilityArea: 'Layers',
    title: 'Layer · ' + layer + ' populated and filterable',
    description: 'All CI types mapped to the ' + layer + ' layer are discovered, stored with the layer, and toggleable on every screen.',
    acceptanceCriteria: 'Layer counts match the synth estate; visibility toggle filters the dependency map and lists.',
    priority: 'P0',
    specSection: 'Layers design · CI_LAYERS',
  }));
  return [...core, ...ui, ...perf, ...sec, ...qa, ...int, ...ai, ...layers];
}

/** Rows from docs/SPEC.md: any markdown table row whose first cell is a REQ id or starts with "REQ". */
export function seedsFromSpec(markdown: string): SeedRow[] {
  const out: SeedRow[] = [];
  let section = '';
  for (const line of markdown.split(/\r?\n/)) {
    const h = /^#{1,3}\s+(.+)$/.exec(line);
    if (h) section = h[1]?.trim() ?? '';
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const first = cells[0] ?? '';
    if (!/^REQ/i.test(first)) continue;
    const ws = (cells[1] ?? '').toUpperCase();
    if (!WS_SET.has(ws)) continue;
    out.push({
      workstream: ws as Workstream,
      capabilityArea: section,
      title: cells[2] ?? first,
      description: cells[3] ?? '',
      acceptanceCriteria: cells[4] ?? 'Per SPEC.md',
      priority: (['P0', 'P1', 'P2'] as const).includes((cells[5] ?? '') as 'P0') ? ((cells[5] ?? 'P1') as 'P0' | 'P1' | 'P2') : 'P1',
      specSection: 'SPEC.md §' + section,
    });
  }
  return out;
}

export function nextId(workstream: Workstream, existing: Requirement[]): string {
  const max = existing
    .filter((r) => r.workstream === workstream)
    .map((r) => Number(r.id.split('-')[2]))
    .reduce((a, b) => Math.max(a, b), 0);
  return 'REQ-' + workstream + '-' + String(max + 1).padStart(ID_PAD_WIDTH, '0');
}

export function materialise(seeds: SeedRow[], existing: Requirement[]): Requirement[] {
  const all = [...existing];
  const added: Requirement[] = [];
  const titles = new Set(existing.map((r) => r.workstream + '|' + r.title));
  for (const s of seeds) {
    const key = s.workstream + '|' + s.title;
    if (titles.has(key)) continue;
    titles.add(key);
    const row: Requirement = {
      id: nextId(s.workstream, all),
      workstream: s.workstream,
      capabilityArea: s.capabilityArea,
      title: s.title,
      description: s.description,
      acceptanceCriteria: s.acceptanceCriteria,
      priority: s.priority,
      status: 'Not started',
      owner: '',
      dependsOn: s.dependsOn ?? [],
      specSection: s.specSection,
      testIds: [],
      evidence: '',
      created: today(),
      updated: today(),
      notes: '',
    };
    all.push(row);
    added.push(row);
  }
  return added;
}

export function loadSeeds(capabilityMapPath: string, specPath: string): SeedRow[] {
  const seeds = [...platformSeeds()];
  if (existsSync(capabilityMapPath)) seeds.push(...seedsFromCapabilityMap(readFileSync(capabilityMapPath, 'utf8')));
  if (existsSync(specPath)) seeds.push(...seedsFromSpec(readFileSync(specPath, 'utf8')));
  return seeds;
}

export function seedComponents(): Component[] {
  return [
    { name: 'PostgreSQL', layer: 'System of record', versionPinned: '17', licence: 'PostgreSQL', runsAs: 'service', airGapReady: 'Y', replacedByOption: '' },
    { name: 'Memgraph', layer: 'Dependency graph', versionPinned: '3.x', licence: 'BSL 1.1 (community)', runsAs: 'service', airGapReady: 'Y', replacedByOption: 'Neo4j Community via packages/graph adapter' },
    { name: 'ClickHouse', layer: 'History and analytics', versionPinned: '25.x', licence: 'Apache-2.0', runsAs: 'service', airGapReady: 'Y', replacedByOption: '' },
    { name: 'Valkey', layer: 'Queues and cache', versionPinned: '8.x', licence: 'BSD-3', runsAs: 'service', airGapReady: 'Y', replacedByOption: 'Redis OSS 7.2' },
    { name: 'Meilisearch', layer: 'Search', versionPinned: '1.x', licence: 'MIT', runsAs: 'service', airGapReady: 'Y', replacedByOption: 'Typesense' },
    { name: 'Keycloak', layer: 'Identity', versionPinned: '26.x', licence: 'Apache-2.0', runsAs: 'service', airGapReady: 'Y', replacedByOption: '' },
    { name: 'OpenBao', layer: 'Secrets', versionPinned: '2.x', licence: 'MPL-2.0', runsAs: 'service', airGapReady: 'Y', replacedByOption: '' },
    { name: 'Apache Superset', layer: 'Embedded analytics', versionPinned: '4.x', licence: 'Apache-2.0', runsAs: 'service', airGapReady: 'Y', replacedByOption: '' },
    { name: 'vLLM', layer: 'LLM serving (GPU)', versionPinned: '0.x', licence: 'Apache-2.0', runsAs: 'service', airGapReady: 'Y', replacedByOption: 'llama.cpp server (CPU)' },
    { name: 'llama.cpp server', layer: 'LLM serving (CPU fallback)', versionPinned: 'pinned build', licence: 'MIT', runsAs: 'service', airGapReady: 'Y', replacedByOption: '' },
    { name: 'NestJS + Fastify + Mercurius', layer: 'API', versionPinned: '11 / 5 / 16', licence: 'MIT', runsAs: 'library', airGapReady: 'Y', replacedByOption: '' },
    { name: 'Next.js + React', layer: 'Console', versionPinned: '15 / 19', licence: 'MIT', runsAs: 'library', airGapReady: 'Y', replacedByOption: '' },
    { name: 'Sigma.js + Graphology', layer: 'Graph rendering', versionPinned: '3.x', licence: 'MIT', runsAs: 'library', airGapReady: 'Y', replacedByOption: '' },
    { name: 'BullMQ', layer: 'Scheduling', versionPinned: '5.x', licence: 'MIT', runsAs: 'library', airGapReady: 'Y', replacedByOption: '' },
    { name: 'Prisma', layer: 'ORM and migrations', versionPinned: '6.x', licence: 'Apache-2.0', runsAs: 'library', airGapReady: 'Y', replacedByOption: '' },
    { name: 'Go toolchain', layer: 'Discovery Node and collectors', versionPinned: '1.23+', licence: 'BSD-3', runsAs: 'library', airGapReady: 'Y', replacedByOption: '' },
    { name: 'gosnmp', layer: 'Collector: SNMP', versionPinned: '1.x', licence: 'BSD-2', runsAs: 'library', airGapReady: 'Y', replacedByOption: '' },
    { name: 'OpenTelemetry + Prometheus client', layer: 'Observability', versionPinned: '1.x', licence: 'Apache-2.0', runsAs: 'library', airGapReady: 'Y', replacedByOption: '' },
    { name: 'k6', layer: 'Performance tests', versionPinned: '2.x', licence: 'AGPL-3.0', runsAs: 'subprocess', airGapReady: 'Y', replacedByOption: '' },
    { name: 'Playwright', layer: 'E2E tests', versionPinned: '1.x', licence: 'Apache-2.0', runsAs: 'library', airGapReady: 'Y', replacedByOption: '' },
    { name: 'graphify', layer: 'Knowledge graph of the repo', versionPinned: '0.9.x', licence: 'MIT', runsAs: 'subprocess', airGapReady: 'Y', replacedByOption: '' },
  ];
}

export function seedContracts(): ContractRow[] {
  return [
    { name: 'ci', file: 'packages/contracts/src/ci.ts', version: '0.1.0', frozenOn: '', lastAdr: 'ADR-002' },
    { name: 'collector', file: 'packages/contracts/src/collector.ts', version: '0.1.0', frozenOn: '', lastAdr: 'ADR-002' },
    { name: 'event', file: 'packages/contracts/src/event.ts', version: '0.1.0', frozenOn: '', lastAdr: 'ADR-002' },
    { name: 'graphql', file: 'packages/contracts/graphql/schema.graphql', version: '0.1.0', frozenOn: '', lastAdr: 'ADR-002' },
    { name: 'asset', file: 'packages/contracts/src/asset.ts', version: '0.1.0', frozenOn: '', lastAdr: 'ADR-002' },
    { name: 'impact', file: 'packages/contracts/src/impact.ts', version: '0.1.0', frozenOn: '', lastAdr: 'ADR-002' },
    { name: 'integration', file: 'packages/contracts/src/integration.ts', version: '0.1.0', frozenOn: '', lastAdr: 'ADR-002' },
  ];
}

export function seedDecisions(): Decision[] {
  return [
    { adr: 'ADR-001', title: 'Monorepo tooling: pnpm workspaces, Turborepo, strict TypeScript, lefthook', status: 'Accepted', date: today(), link: 'docs/adr/ADR-001-monorepo-tooling.md' },
    { adr: 'ADR-002', title: 'Contracts drafted at 0.1.0 from CLAUDE.md and the design canvas while SPEC.md is pending', status: 'Accepted', date: today(), link: 'docs/adr/ADR-002-contracts-without-spec.md' },
    { adr: 'ADR-003', title: 'Go for the Discovery Node and collectors (Rust considered and declined)', status: 'Accepted', date: today(), link: 'docs/adr/ADR-003-go-for-node-and-collectors.md' },
    { adr: 'ADR-004', title: 'Twelve-layer model with user-labelled unknowns', status: 'Accepted', date: today(), link: 'docs/adr/ADR-004-layer-model.md' },
    { adr: 'ADR-005', title: 'Infrastructure plans with BOM replace purchase orders', status: 'Accepted', date: today(), link: 'docs/adr/ADR-005-plans-not-purchase-orders.md' },
  ];
}

export function seedRisks(): Risk[] {
  return [
    { id: 'R-001', risk: 'docs/SPEC.md not yet provided; requirements seeded from CLAUDE.md, the capability map and the design canvas', likelihood: 'High', impact: 'Medium', mitigation: 'Re-run tracker init when SPEC.md lands; reconcile rows; ADR-002', owner: 'Syed', status: 'Open' },
    { id: 'R-002', risk: 'Go toolchain not installed on the build machine', likelihood: 'High', impact: 'High', mitigation: 'Install Go 1.23+; CI image includes it', owner: 'Syed', status: 'Open' },
    { id: 'R-003', risk: 'Memgraph community licence (BSL) constraints for commercial redistribution', likelihood: 'Medium', impact: 'Medium', mitigation: 'packages/graph adapter keeps Neo4j Community as a drop-in', owner: 'Claude', status: 'Mitigating' },
    { id: 'R-004', risk: 'Vendor fixtures require access to real devices for every collector family', likelihood: 'High', impact: 'High', mitigation: 'Record fixtures in the vendor lab per family; never fabricate', owner: 'Syed', status: 'Open' },
    { id: 'R-005', risk: '100k-node impact query budget of 1 s depends on Memgraph tuning and graph shape', likelihood: 'Medium', impact: 'High', mitigation: 'Synth estate perf tests from day one; precomputed service closure', owner: 'Claude', status: 'Mitigating' },
    { id: 'R-006', risk: 'k6 is AGPL; must run as a separate process, never linked', likelihood: 'Low', impact: 'Medium', mitigation: 'Invoke k6 binary from tools/perf only', owner: 'Claude', status: 'Mitigating' },
  ];
}
