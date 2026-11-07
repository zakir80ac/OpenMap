// REQ-CORE-013 — reconciles one CollectorResult into stored CIs and relationships, producing the
// writes and outbox events the stores apply. Pure: the caller supplies lookups and persists outputs.
import { randomUUID } from 'node:crypto';
import { IMPORTS, RECONCILER, RECONCILIATION } from '@openmap/constants';
import { CI_TYPE_LAYER, ciCode, refDepth, refPairs, type Ci, type CollectorResult, type Component, type EventEnvelope, type MetricSample, type ObservedCi, type ObservedRelationship, type Relationship } from '@openmap/contracts';
import { identityKeysOf, MapRefIndex, refKeyOf, resolve, type IdentityIndex } from './identity.js';
import { checksum, merge } from './merge.js';
import { envelope } from './events.js';
import { sanitizeResult } from './sanitize.js';

export interface StoredLookup {
  index: IdentityIndex;
  /**
   * ADR-045: the CIs the result's `*Ref` values may name, from the store. Reconciliation adds every CI of the result
   * as it resolves it, so a ref can name a CI the same result creates.
   */
  refs: MapRefIndex;
  /** The ref key stored for a CI: null while its refs are pending, undefined for a CI the lookup did not load. */
  storedRefKey(ciId: string): string | null | undefined;
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
  /**
   * ADR-045: the ref key of every CI this result created or updated whose identity carries a `*Ref`, and of every other
   * CI it saw whose ref key changed; null while a ref names no single known CI (the pending pass retries it).
   */
  refKeys: Map<string, string | null>;
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
  for (const k of identityKeysOf(ref, refKeyOf(ref, lookup.refs))) {
    const fresh = created.get(k);
    if (fresh) return fresh;
    const stored = lookup.index.lookup(k);
    if (stored) return stored;
  }
  return undefined;
}

export function reconcile(input: CollectorResult, lookup: StoredLookup): ReconcileOutput {
  const result = sanitizeResult(input);
  const out: ReconcileOutput = { created: [], updated: [], unchanged: 0, relationshipsCreated: [], relationshipsSeen: [], conflicts: [], unresolvedRelationships: [], events: [], samples: 0, samplesDropped: 0, components: [], refKeys: new Map() };
  const createdByKey = new Map<string, string>();
  const provenance = { collectorId: result.collectorId, nodeId: result.nodeId, runId: result.runId };

  // ADR-045: CIs that name nothing first, so a listener's hostRef can name the host the same result reports.
  const ordered = [...result.cis].sort((a, b) => refDepth(a.type) - refDepth(b.type));
  for (const observed of ordered) {
    const hasRefs = refPairs(observed).length > 0;
    const refKey = hasRefs ? refKeyOf(observed, lookup.refs) : null;
    const resolution = resolve(observed, lookup.index, refKey);
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
      for (const k of identityKeysOf(observed, refKey)) createdByKey.set(k, id);
      lookup.refs.add(ci, id);
      if (hasRefs) out.refKeys.set(id, refKey);
      out.events.push(envelope(result.tenantId, 'openmap.ci.created', id, { ci }));
      continue;
    }
    const existing = lookup.getCi(resolution.ciId);
    if (!existing) continue;
    if (observed.components !== undefined) out.components.push({ ciId: existing.id, tenantId: result.tenantId, existed: true, components: observed.components });
    const merged = merge({ attributes: existing.attributes, source: existing.source, observedAt: existing.observedAt }, { attributes: observed.attributes, source, observedAt: observed.observedAt });
    // Identity values are stable once stored; new keys are added, existing ones keep their canonical spelling.
    const identity = { ...observed.identity, ...existing.identity };
    const mergedRefKey = hasRefs || refPairs(existing).length > 0 ? refKeyOf({ type: existing.type, identity }, lookup.refs) : null;
    lookup.refs.add({ type: existing.type, identity, name: existing.name, attributes: merged.attributes }, existing.id);
    const newChecksum = checksum(existing.type, identity, merged.attributes);
    if (newChecksum === existing.checksum) {
      out.unchanged++;
      const stored = lookup.storedRefKey(existing.id);
      if (stored !== undefined && stored !== mergedRefKey) out.refKeys.set(existing.id, mergedRefKey);
      continue;
    }
    if (mergedRefKey !== null || refPairs({ type: existing.type, identity }).length > 0) out.refKeys.set(existing.id, mergedRefKey);
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
