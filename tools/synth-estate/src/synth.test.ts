// T-025 REQ-QA-001 — synthetic estate: determinism, contract validity, referential integrity.
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SYNTH_ESTATE } from '@openmap/constants';
import { CI_IDENTITY_KEYS, CI_TYPE_LAYER, collectorResultSchema, RELATIONSHIP_TYPES, type CiType, type CollectorResult } from '@openmap/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildEstate, summarise, type Estate } from './estate.js';
import { emitEstate, NDJSON_SUFFIX, SERVICES_FILE, SUMMARY_FILE } from './emit.js';

const SCALE = 0.01;
const SEED = 42;
const TIME_BUDGET_MS = 10_000;

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function identityKey(type: string, identity: Record<string, string>): string {
  return type + '|' + JSON.stringify(Object.keys(identity).sort().map((k) => [k, identity[k]]));
}

function readResults(dir: string): CollectorResult[] {
  const out: CollectorResult[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(NDJSON_SUFFIX)).sort()) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (line.length === 0) continue;
      out.push(collectorResultSchema.parse(JSON.parse(line)));
    }
  }
  return out;
}

describe('synth-estate', () => {
  let estate: Estate;
  let dirA: string;
  let dirB: string;
  let elapsedMs = 0;
  let results: CollectorResult[] = [];

  beforeAll(async () => {
    dirA = mkdtempSync(join(tmpdir(), 'synth-a-'));
    dirB = mkdtempSync(join(tmpdir(), 'synth-b-'));
    const t0 = performance.now();
    estate = buildEstate(SEED, SCALE);
    await emitEstate(estate, dirA);
    elapsedMs = performance.now() - t0;
    await emitEstate(buildEstate(SEED, SCALE), dirB);
    results = readResults(dirA);
  });

  afterAll(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it('produces byte-identical output for the same seed', () => {
    const filesA = readdirSync(dirA).sort();
    const filesB = readdirSync(dirB).sort();
    expect(filesA).toEqual(filesB);
    expect(filesA.length).toBeGreaterThan(5);
    for (const f of filesA) expect(sha256(join(dirA, f)), f).toBe(sha256(join(dirB, f)));
  });

  it('differs for a different seed', async () => {
    const dirC = mkdtempSync(join(tmpdir(), 'synth-c-'));
    try {
      await emitEstate(buildEstate(SEED + 1, SCALE), dirC);
      expect(sha256(join(dirC, 'snmp' + NDJSON_SUFFIX))).not.toBe(sha256(join(dirA, 'snmp' + NDJSON_SUFFIX)));
    } finally {
      rmSync(dirC, { recursive: true, force: true });
    }
  });

  it('generates and emits scale 0.01 within the test time budget', () => {
    expect(elapsedMs).toBeLessThan(TIME_BUDGET_MS);
  });

  it('validates every emitted result against the collector contract', () => {
    expect(results.length).toBe(estate.builder.slots.length);
    for (const r of results) {
      expect(r.evidence.length).toBeGreaterThan(0);
      expect(r.metrics.cisEmitted).toBe(r.cis.length);
      expect(r.metrics.relationshipsEmitted).toBe(r.relationships.length);
      expect(Date.parse(r.finishedAt)).toBeGreaterThanOrEqual(Date.parse(r.startedAt));
      expect(r.status === 'partial' ? r.errors.length > 0 : r.errors.length === 0).toBe(true);
    }
  });

  it('carries a SHA-256 digest of the JSON of the CIs as evidence', () => {
    for (const r of results) {
      const digest = createHash('sha256').update(JSON.stringify(r.cis)).digest('hex');
      expect(r.evidence[0]?.digest).toBe(digest);
      expect(r.evidence[0]?.sizeBytes).toBe(Buffer.byteLength(JSON.stringify(r.cis)));
    }
  });

  it('resolves every relationship endpoint to an emitted CI', () => {
    const known = new Set<string>();
    for (const r of results) for (const ci of r.cis) known.add(identityKey(ci.type, ci.identity));
    let checked = 0;
    for (const r of results) {
      for (const rel of r.relationships) {
        expect(RELATIONSHIP_TYPES).toContain(rel.type);
        if ('identity' in rel.from) expect(known.has(identityKey(rel.from.type, rel.from.identity)), rel.type + ' from').toBe(true);
        if ('identity' in rel.to) expect(known.has(identityKey(rel.to.type, rel.to.identity)), rel.type + ' to').toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('keeps layer counts consistent with CI_TYPE_LAYER', () => {
    const summary = summarise(estate);
    const expected: Record<string, number> = {};
    for (const [type, n] of Object.entries(summary.ciTypes)) {
      const layer = CI_TYPE_LAYER[type as CiType];
      expected[layer] = (expected[layer] ?? 0) + n;
    }
    expect(summary.layers).toEqual(expected);
    const written = JSON.parse(readFileSync(join(dirA, SUMMARY_FILE), 'utf8')) as { layers: Record<string, number> };
    expect(written.layers).toEqual(expected);
    expect(Object.keys(summary.layers).sort()).toEqual(['applications', 'cloud', 'containers', 'databases', 'dc', 'hardware', 'network_security', 'os', 'storage', 'unknown', 'virtualization'].sort());
  });

  it('emits round(300 × scale) business services', () => {
    const expected = Math.round(SYNTH_ESTATE.businessServices * SCALE);
    expect(estate.services.length).toBe(expected);
    const services = JSON.parse(readFileSync(join(dirA, SERVICES_FILE), 'utf8')) as unknown[];
    expect(services.length).toBe(expected);
    const cis = results.flatMap((r) => r.cis).filter((c) => c.type === 'business_service');
    expect(cis.length).toBe(expected);
    for (const s of estate.services) expect(s.applications.length).toBeGreaterThanOrEqual(2);
  });

  it('fills every identity key of CI_IDENTITY_KEYS for every CI', () => {
    for (const ci of estate.builder.cis) {
      for (const key of CI_IDENTITY_KEYS[ci.type]) expect(ci.identity[key], ci.type + ' ' + ci.name + ' ' + key).toBeTruthy();
    }
    for (const r of results) for (const ci of r.cis) for (const key of CI_IDENTITY_KEYS[ci.type]) expect(ci.identity[key]).toBeTruthy();
  });

  it('scales the headline populations', () => {
    const summary = summarise(estate);
    expect(summary.ciTypes['network_device']).toBeGreaterThanOrEqual(Math.round(SYNTH_ESTATE.networkDevices * SCALE) - 1);
    expect(summary.ciTypes['host']).toBe(Math.round(SYNTH_ESTATE.hosts * SCALE));
    expect(summary.ciTypes['vm']).toBe(Math.round(SYNTH_ESTATE.vms * SCALE));
    expect(summary.ciTypes['site']).toBe(7);
    expect(summary.ciTypes['unknown']).toBe(Math.round(214 * SCALE));
    expect(summary.ciTypes['k8s_service']).toBe(Math.round(SYNTH_ESTATE.k8sServices * SCALE));
    expect(summary.ciTypes['bmc']).toBe(summary.ciTypes['host']);
  });

  it('keeps addresses inside RFC 1918 10/8 and hostnames in the bank domain', () => {
    for (const r of results) {
      for (const ci of r.cis) {
        if (ci.type === 'ip_address') expect(ci.identity['address']?.startsWith('10.')).toBe(true);
        if (ci.type === 'host' || ci.type === 'vm') expect(ci.identity['fqdn']?.endsWith('.bank.local')).toBe(true);
      }
    }
  });

  it('chunks sweeps at the discovery budget', () => {
    for (const slot of estate.builder.slots) expect(slot.primaryCount).toBeLessThanOrEqual(estate.builder.maxPrimaryPerSlot);
  });
});
