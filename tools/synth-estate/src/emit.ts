// REQ-QA-001 — slices the estate into CollectorResults (one per slot: family, collector, node,
// sweep chunk), validates each against the collector contract and streams it as NDJSON, one file
// per collector family. Evidence carries the SHA-256 of the JSON of the CIs in the result.
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLLECTOR_FAMILIES, CONTRACT_VERSIONS, collectorResultSchema, type CollectorFamily, type CollectorResult, type ObservedCi, type ObservedRelationship } from '@openmap/contracts';
import { summarise, type Estate, type EstateSummary, type Slot } from './estate.js';
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

/** Builds one CollectorResult for a slot from the CI and relationship indices assigned to it. */
export function buildResult(estate: Estate, slot: Slot, ciIdx: readonly number[], relIdx: readonly number[], rng: Rng): CollectorResult {
  const { builder } = estate;
  const cis: ObservedCi[] = ciIdx.map((i) => {
    const ci = builder.get(i);
    return { type: ci.type, identity: ci.identity, name: ci.name, attributes: ci.attributes, tags: ci.tags, externalIds: ci.externalIds, observedAt: slot.observedAt };
  });
  const relationships: ObservedRelationship[] = relIdx.map((i) => {
    const rel = builder.rels[i];
    if (!rel) throw new Error('no relationship at index ' + String(i));
    const from = builder.get(rel.from);
    const to = builder.get(rel.to);
    return { type: rel.type, from: { type: from.type, identity: from.identity }, to: { type: to.type, identity: to.identity }, attributes: rel.attributes ?? {}, observedAt: slot.observedAt };
  });
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
