// REQ-QA-001 — slices the estate into CollectorResults (one per slot: family, collector, node,
// sweep chunk), validates each against the collector contract and streams it as NDJSON, one file
// per collector family. Evidence carries the SHA-256 of the JSON of the CIs in the result.
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CI_TYPE_LAYER, COLLECTOR_FAMILIES, CONTRACT_VERSIONS, LAYER_HEADLINE_METRIC, collectorResultSchema, componentSchema, type CollectorFamily, type CollectorResult, type HeadlineMetricKey, type MetricSample, type ObservedCi, type ObservedRelationship } from '@openmap/contracts';
import { summarise, type Estate, type EstateCi, type EstateSummary, type Slot } from './estate.js';
import { Rng } from './rng.js';
import { ESTATE_EPOCH_MS } from './time.js';

export interface EmittedFile {
  family: CollectorFamily;
  path: string;
  results: number;
  cis: number;
  relationships: number;
  bytes: number;
}

export interface EmitReport {
  outDir: string;
  files: EmittedFile[];
  summary: EstateSummary;
  summaryPath: string;
  servicesPath: string;
  organizationPath: string;
  durationMs: number;
}

export const SUMMARY_FILE = 'estate-summary.json';
export const SERVICES_FILE = 'services.json';
export const ORGANIZATION_FILE = 'organization.json';
export const NDJSON_SUFFIX = '.ndjson';

/** Base and per-target costs used to derive a plausible, deterministic run duration. */
const RUN_BASE_MS = 1200;
const RUN_PER_TARGET_MS = 85;
const RUN_PER_CI_MS = 2;
/** One unreachable target per this many sweep targets, so pipelines see partial results. */
const UNREACHABLE_EVERY = 500;
const ERROR_MESSAGES: Partial<Record<CollectorFamily, string>> = {
  snmp: 'SNMP request timed out after 3 retries',
  ssh_agentless: 'SSH connection refused',
  wmi: 'RPC server unavailable',
  ipmi_redfish: 'Redfish service root returned 503',
  port_scan: 'host did not answer any probe',
  netflow: 'exporter template not yet received',
};

function compareSlots(a: Slot, b: Slot): number {
  return a.id - b.id;
}

/**
 * REQ-CMDB-038 — every CI of a known layer carries one sample of its layer's headline metric per result, so the
 * replayed estate fills ClickHouse `metrics` the way a real sweep would. Values come from the CI's own attributes
 * when the generator already set one (DHCP scope utilisation, PDU load) and from the slot's RNG otherwise, inside
 * the range an operator would expect for the measurement.
 */
const HEADLINE_UNITS: Record<HeadlineMetricKey, string> = {
  pue: 'ratio',
  throughputGbps: 'Gbps',
  cpuPercent: 'percent',
  iops: 'iops',
  loadPercent: 'percent',
  patchCompliancePercent: 'percent',
  apdex: 'ratio',
  seatUtilisationPercent: 'percent',
  lastSeenDays: 'days',
};
const HEADLINE_RANGES: Record<HeadlineMetricKey, readonly [number, number, number]> = {
  // [min, max, decimals]
  pue: [1.18, 2.05, 2],
  throughputGbps: [0.05, 38, 2],
  cpuPercent: [3, 94, 1],
  iops: [120, 48_000, 0],
  loadPercent: [4, 91, 1],
  patchCompliancePercent: [62, 100, 1],
  apdex: [0.71, 1, 2],
  seatUtilisationPercent: [18, 99, 1],
  lastSeenDays: [0, 30, 0],
};
/** Attribute names whose value already is the headline measurement, by headline key. */
const HEADLINE_ATTRIBUTES: Partial<Record<HeadlineMetricKey, readonly string[]>> = {
  cpuPercent: ['cpuPercent', 'cpuUtilisationPercent'],
  loadPercent: ['loadPercent', 'utilisationPercent'],
  seatUtilisationPercent: ['seatUtilisationPercent'],
  throughputGbps: ['throughputGbps'],
};
const SUBNET_UTILISATION_METRIC = 'ipam.subnet.utilisation_percent';
const POWER_METRIC = 'dcim.power.watts';
const SUBNET_UTILISATION_RANGE: readonly [number, number] = [4, 88];
const PDU_WATTS_RANGE: readonly [number, number] = [600, 4200];
const WATTS_PER_KILOWATT = 1000;
const PERCENT = 100;
const MEGABITS_PER_GIGABIT = 1000;

function numberAttribute(ci: EstateCi, names: readonly string[]): number | undefined {
  for (const name of names) {
    const value = ci.attributes[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function rounded(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

/**
 * REQ-UI-026 — a site link's traffic follows its committed bandwidth and the utilisation the generator gave it, so the
 * Sites screen's throughput-against-capacity reads like a real circuit rather than a figure drawn for any network CI.
 */
function linkThroughputGbps(ci: EstateCi, decimals: number): number | undefined {
  if (ci.type !== 'site_link') return undefined;
  const bandwidthMbps = numberAttribute(ci, ['bandwidthMbps']);
  const utilisationPercent = numberAttribute(ci, ['utilisationPercent']);
  if (bandwidthMbps === undefined || utilisationPercent === undefined) return undefined;
  return rounded((bandwidthMbps * utilisationPercent) / PERCENT / MEGABITS_PER_GIGABIT, decimals);
}

export function samplesFor(ci: EstateCi, ts: string, rng: Rng): MetricSample[] {
  const layer = CI_TYPE_LAYER[ci.type];
  if (layer === 'unknown') return [];
  const spec = LAYER_HEADLINE_METRIC[layer];
  const [min, max, decimals] = HEADLINE_RANGES[spec.key];
  // The draw always happens, so the RNG stream (and every later value and run id) is the same whichever source wins.
  const drawn = rounded(rng.float(min, max), decimals);
  const value = numberAttribute(ci, HEADLINE_ATTRIBUTES[spec.key] ?? []) ?? linkThroughputGbps(ci, decimals) ?? drawn;
  const ref = { type: ci.type, identity: ci.identity };
  const samples: MetricSample[] = [{ ci: ref, metric: spec.metric, ts, value, unit: HEADLINE_UNITS[spec.key], labels: {} }];
  if (ci.type === 'subnet') {
    const [lo, hi] = SUBNET_UTILISATION_RANGE;
    samples.push({ ci: ref, metric: SUBNET_UTILISATION_METRIC, ts, value: rounded(rng.float(lo, hi), 1), unit: 'percent', labels: { cidr: ci.identity['cidr'] ?? '', vrf: ci.identity['vrfRef'] ?? '' } });
  }
  if (ci.type === 'pdu') {
    const [lo, hi] = PDU_WATTS_RANGE;
    const measuredKw = numberAttribute(ci, ['measuredKw']);
    const watts = measuredKw === undefined ? rounded(rng.float(lo, hi), 0) : rounded(measuredKw * WATTS_PER_KILOWATT, 0);
    const feed = ci.attributes['feed'];
    const rack = ci.attributes['rack'];
    // `rack` is the rack's name; `rack_id` (the rack CI id that power_by_rack_hourly keys on) is only known once the
    // reconciler has resolved it, which collectors never do (packages/db/clickhouse/README.md).
    samples.push({ ci: ref, metric: POWER_METRIC, ts, value: watts, unit: 'W', labels: { pdu_id: ci.identity['serialNumber'] ?? '', feed: typeof feed === 'string' ? feed : '', rack: typeof rack === 'string' ? rack : '' } });
  }
  return samples;
}

/** Builds one CollectorResult for a slot from the CI and relationship indices assigned to it. */
export function buildResult(estate: Estate, slot: Slot, ciIdx: readonly number[], relIdx: readonly number[], rng: Rng): CollectorResult {
  const { builder } = estate;
  const cis: ObservedCi[] = ciIdx.map((i) => {
    const ci = builder.get(i);
    const observed: ObservedCi = { type: ci.type, identity: ci.identity, name: ci.name, attributes: ci.attributes, tags: ci.tags, externalIds: ci.externalIds, observedAt: slot.observedAt };
    // Schema key order, so the evidence digest matches the result as a validator re-serialises it.
    if (ci.components !== undefined) observed.components = ci.components.map((c) => componentSchema.parse(c));
    return observed;
  });
  const relationships: ObservedRelationship[] = relIdx.map((i) => {
    const rel = builder.rels[i];
    if (!rel) throw new Error('no relationship at index ' + String(i));
    const from = builder.get(rel.from);
    const to = builder.get(rel.to);
    return { type: rel.type, from: { type: from.type, identity: from.identity }, to: { type: to.type, identity: to.identity }, attributes: rel.attributes ?? {}, observedAt: slot.observedAt };
  });
  const samples: MetricSample[] = ciIdx.flatMap((i) => samplesFor(builder.get(i), slot.observedAt, rng));
  const ciJson = JSON.stringify(cis);
  const digest = createHash('sha256').update(ciJson).digest('hex');
  const failures = Math.floor(slot.primaryCount / UNREACHABLE_EVERY);
  const targets = Math.max(1, slot.primaryCount);
  const durationMs = RUN_BASE_MS + targets * RUN_PER_TARGET_MS + cis.length * RUN_PER_CI_MS;
  const startedMs = Date.parse(slot.observedAt) - durationMs;
  const errors = Array.from({ length: failures }, (_, n) => ({
    target: { kind: slot.target.kind, value: slot.target.value, label: 'unreachable target ' + String(n + 1) + ' of sweep' },
    code: n % 2 === 0 ? ('unreachable' as const) : ('timeout' as const),
    message: ERROR_MESSAGES[slot.family] ?? 'target did not respond within the job timeout',
    retryable: true,
  }));
  const result: CollectorResult = {
    jobId: rng.uuid(),
    runId: rng.uuid(),
    tenantId: estate.tenantId,
    collectorId: slot.collectorId,
    nodeId: slot.nodeId,
    status: failures > 0 ? 'partial' : 'success',
    startedAt: new Date(Math.max(ESTATE_EPOCH_MS - durationMs, startedMs)).toISOString(),
    finishedAt: slot.observedAt,
    cis,
    relationships,
    samples,
    evidence: [{ kind: slot.evidenceKind, target: slot.target, digest, sizeBytes: Buffer.byteLength(ciJson), capturedAt: slot.observedAt }],
    errors,
    metrics: { targetsAttempted: targets + failures, targetsReached: targets, cisEmitted: cis.length, relationshipsEmitted: relationships.length, durationMs },
    contractVersion: CONTRACT_VERSIONS.collector,
  };
  return collectorResultSchema.parse(result);
}

/** Groups CI and relationship indices by slot without copying CI objects. */
export function groupBySlot(estate: Estate): { cisBySlot: number[][]; relsBySlot: number[][] } {
  const { builder } = estate;
  const cisBySlot: number[][] = builder.slots.map(() => []);
  const relsBySlot: number[][] = builder.slots.map(() => []);
  builder.cis.forEach((ci, i) => cisBySlot[ci.slot]?.push(i));
  builder.rels.forEach((rel, i) => relsBySlot[rel.slot]?.push(i));
  return { cisBySlot, relsBySlot };
}

async function writeLine(stream: NodeJS.WritableStream & { write(chunk: string): boolean }, line: string): Promise<void> {
  if (!stream.write(line)) await once(stream, 'drain');
}

export async function emitEstate(estate: Estate, outDir: string): Promise<EmitReport> {
  const started = performance.now();
  mkdirSync(outDir, { recursive: true });
  const { cisBySlot, relsBySlot } = groupBySlot(estate);
  const rng = new Rng(estate.seed).fork('emit');
  const files: EmittedFile[] = [];
  const slotsByFamily = new Map<CollectorFamily, Slot[]>();
  for (const slot of estate.builder.slots) {
    const list = slotsByFamily.get(slot.family) ?? [];
    list.push(slot);
    slotsByFamily.set(slot.family, list);
  }
  for (const family of COLLECTOR_FAMILIES) {
    const slots = slotsByFamily.get(family);
    if (!slots || slots.length === 0) continue;
    slots.sort(compareSlots);
    const path = join(outDir, family + NDJSON_SUFFIX);
    const stream = createWriteStream(path, { encoding: 'utf8' });
    const file: EmittedFile = { family, path, results: 0, cis: 0, relationships: 0, bytes: 0 };
    for (const slot of slots) {
      const result = buildResult(estate, slot, cisBySlot[slot.id] ?? [], relsBySlot[slot.id] ?? [], rng);
      const line = JSON.stringify(result) + '\n';
      await writeLine(stream, line);
      file.results++;
      file.cis += result.cis.length;
      file.relationships += result.relationships.length;
      file.bytes += Buffer.byteLength(line);
    }
    stream.end();
    await once(stream, 'finish');
    files.push(file);
  }
  const summary = summarise(estate);
  const summaryPath = join(outDir, SUMMARY_FILE);
  const servicesPath = join(outDir, SERVICES_FILE);
  const organizationPath = join(outDir, ORGANIZATION_FILE);
  writeFileSync(summaryPath, JSON.stringify({ ...summary, files: files.map((f) => ({ family: f.family, file: f.family + NDJSON_SUFFIX, results: f.results, cis: f.cis, relationships: f.relationships, bytes: f.bytes })) }, null, 2) + '\n');
  writeFileSync(servicesPath, JSON.stringify(estate.services, null, 2) + '\n');
  writeFileSync(organizationPath, JSON.stringify({ organization: estate.organization, sites: estate.sites, siteLinks: estate.siteLinks }, null, 2) + '\n');
  return { outDir, files, summary, summaryPath, servicesPath, organizationPath, durationMs: Math.round(performance.now() - started) };
}
