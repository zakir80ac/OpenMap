// REQ-CORE-013 — reconciles one CollectorResult into stored CIs and relationships, producing the
// writes and outbox events the stores apply. Pure: the caller supplies lookups and persists outputs.
import { randomUUID } from 'node:crypto';
import { IMPORTS, RECONCILER, RECONCILIATION } from '@openmap/constants';
import { CI_TYPE_LAYER, ciCode, type Ci, type CollectorResult, type Component, type EventEnvelope, type MetricSample, type ObservedCi, type ObservedRelationship, type Relationship } from '@openmap/contracts';
import { identityKeysOf, resolve, type IdentityIndex } from './identity.js';
import { checksum, merge } from './merge.js';
import { envelope } from './events.js';
import { sanitizeResult } from './sanitize.js';

export interface StoredLookup {
  index: IdentityIndex;
  getCi(ciId: string): Ci | undefined;
  /** Finds a current relationship of this type between two CIs. */
  findRelationship(type: Relationship['type'], fromCiId: string, toCiId: string): Relationship | undefined;
}

export interface ReconcileOutput {
  created: Ci[];
  updated: Ci[];
  unchanged: number;
  relationshipsCreated: Relationship[];
  relationshipsSeen: string[];
  conflicts: Array<{ observed: ObservedCi; ciIds: string[] }>;
  unresolvedRelationships: ObservedRelationship[];
  events: EventEnvelope[];
  /** Metric samples bound to a CI id and carried by `openmap.metric.sampled` events (ADR-016). */
  samples: number;
  /** Samples whose CI neither this result nor the store knows; they are not parked, the next sweep samples again. */
  samplesDropped: number;
  /** ADR-037: the part lists observations carried, by resolved CI; `existed` is false for a CI this result created. */
  components: ObservedComponents[];
}

export interface ObservedComponents {
  ciId: string;
  tenantId: string;
  existed: boolean;
  components: Component[];
}

/** A sample as the dispatcher writes it to ClickHouse: the CI reference replaced by the stored id. */
export interface ResolvedSample extends Omit<MetricSample, 'ci'> {
  ciId: string;
}

function refToId(ref: ObservedRelationship['from'], lookup: StoredLookup, created: Map<string, string>): string | undefined {
  if ('id' in ref) return ref.id;
  for (const k of identityKeysOf(ref)) {
    const fresh = created.get(k);
    if (fresh) return fresh;
    const stored = lookup.index.lookup(k);
    if (stored) return stored;
  }
  return undefined;
}

export function reconcile(input: CollectorResult, lookup: StoredLookup): ReconcileOutput {
  const result = sanitizeResult(input);
  const out: ReconcileOutput = { created: [], updated: [], unchanged: 0, relationshipsCreated: [], relationshipsSeen: [], conflicts: [], unresolvedRelationships: [], events: [], samples: 0, samplesDropped: 0, components: [] };
  const createdByKey = new Map<string, string>();
  const provenance = { collectorId: result.collectorId, nodeId: result.nodeId, runId: result.runId };

  for (const observed of result.cis) {
    const resolution = resolve(observed, lookup.index);
    const source = { ...provenance, confidence: confidenceFor(observed, result.collectorId) };
    if (resolution.kind === 'conflict') {
      out.conflicts.push({ observed, ciIds: resolution.ciIds });
      out.events.push(envelope(result.tenantId, 'openmap.reconciliation.conflict', observed.name, { type: observed.type, identity: observed.identity, ciIds: resolution.ciIds, matchedKeys: resolution.matchedKeys }));
      continue;
    }
    if (resolution.kind === 'new') {
      const id = randomUUID();
      const layer = CI_TYPE_LAYER[observed.type];
      const { components: parts, ...fields } = observed;
      if (parts !== undefined) out.components.push({ ciId: id, tenantId: result.tenantId, existed: false, components: parts });
      const ci: Ci = {
        ...fields,
        id,
        tenantId: result.tenantId,
        displayName: observed.name,
        code: ciCode(layer, observed.type, observed.name),
        layer,
        userLabel: null,
        lifecycle: result.collectorId === IMPORTS.collectorId ? IMPORTS.createdLifecycle : 'discovered',
        source,
        validFrom: observed.observedAt,
        validTo: null,
        checksum: checksum(observed.type, observed.identity, observed.attributes),
      };
      out.created.push(ci);
      for (const k of identityKeysOf(observed)) createdByKey.set(k, id);
      out.events.push(envelope(result.tenantId, 'openmap.ci.created', id, { ci }));
      continue;
    }
    const existing = lookup.getCi(resolution.ciId);
    if (!existing) continue;
    if (observed.components !== undefined) out.components.push({ ciId: existing.id, tenantId: result.tenantId, existed: true, components: observed.components });
    const merged = merge({ attributes: existing.attributes, source: existing.source, observedAt: existing.observedAt }, { attributes: observed.attributes, source, observedAt: observed.observedAt });
    // Identity values are stable once stored; new keys are added, existing ones keep their canonical spelling.
    const identity = { ...observed.identity, ...existing.identity };
    const newChecksum = checksum(existing.type, identity, merged.attributes);
    if (newChecksum === existing.checksum) {
      out.unchanged++;
      continue;
    }
    const updated: Ci = { ...existing, identity, attributes: merged.attributes, source: merged.source, observedAt: observed.observedAt, checksum: newChecksum, tags: [...new Set([...existing.tags, ...observed.tags])] };
    out.updated.push(updated);
    out.events.push(envelope(result.tenantId, 'openmap.ci.updated', updated.id, { ci: updated, changedKeys: merged.changedKeys }));
  }

  for (const rel of result.relationships) {
    const fromId = refToId(rel.from, lookup, createdByKey);
    const toId = refToId(rel.to, lookup, createdByKey);
    if (!fromId || !toId) {
      out.unresolvedRelationships.push(rel);
      continue;
    }
    const current = lookup.findRelationship(rel.type, fromId, toId);
    if (current) {
      out.relationshipsSeen.push(current.id);
      continue;
    }
    const created: Relationship = {
      id: randomUUID(),
      tenantId: result.tenantId,
      type: rel.type,
      fromCiId: fromId,
      toCiId: toId,
      attributes: rel.attributes,
      source: { ...provenance, confidence: RECONCILIATION.userLabelConfidence },
      observedAt: rel.observedAt,
      validFrom: rel.observedAt,
      validTo: null,
    };
    out.relationshipsCreated.push(created);
    out.events.push(envelope(result.tenantId, 'openmap.relationship.created', created.id, { relationship: created }));
  }

  const resolved: ResolvedSample[] = [];
  for (const sample of result.samples) {
    const ciId = refToId(sample.ci, lookup, createdByKey);
    if (!ciId) {
      out.samplesDropped++;
      continue;
    }
    const { ci: _ref, ...rest } = sample;
    resolved.push({ ...rest, ciId });
  }
  out.samples = resolved.length;
  for (let start = 0; start < resolved.length; start += RECONCILER.samplesPerEvent) {
    const samples = resolved.slice(start, start + RECONCILER.samplesPerEvent);
    out.events.push(envelope(result.tenantId, 'openmap.metric.sampled', result.runId, { runId: result.runId, collectorId: result.collectorId, samples }));
  }
  return out;
}

/**
 * Observations from port scans and unknown classification are weaker than authenticated collectors; an import from a
 * spreadsheet or another CMDB (REQ-CMDB-036, ADR-032) is weaker still than discovery, so it only fills gaps.
 */
function confidenceFor(observed: ObservedCi, collectorId: string): number {
  if (collectorId === IMPORTS.collectorId) return RECONCILIATION.importSeedConfidence;
  return observed.type === 'unknown' ? RECONCILIATION.overwriteMinConfidence : RECONCILIATION.discoveryDefaultConfidence;
}
