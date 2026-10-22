// REQ-CORE-013 — reconciles one CollectorResult into stored CIs and relationships, producing the
// writes and outbox events the stores apply. Pure: the caller supplies lookups and persists outputs.
import { randomUUID } from 'node:crypto';
import { RECONCILIATION } from '@openmap/constants';
import { CI_TYPE_LAYER, ciCode, type Ci, type CollectorResult, type EventEnvelope, type ObservedCi, type ObservedRelationship, type Relationship } from '@openmap/contracts';
import { identityKeysOf, resolve, type IdentityIndex } from './identity.js';
import { checksum, merge } from './merge.js';
import { envelope } from './events.js';

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

export function reconcile(result: CollectorResult, lookup: StoredLookup): ReconcileOutput {
  const out: ReconcileOutput = { created: [], updated: [], unchanged: 0, relationshipsCreated: [], relationshipsSeen: [], conflicts: [], unresolvedRelationships: [], events: [] };
  const createdByKey = new Map<string, string>();
  const provenance = { collectorId: result.collectorId, nodeId: result.nodeId, runId: result.runId };

  for (const observed of result.cis) {
    const resolution = resolve(observed, lookup.index);
    const source = { ...provenance, confidence: confidenceFor(observed) };
    if (resolution.kind === 'conflict') {
      out.conflicts.push({ observed, ciIds: resolution.ciIds });
      out.events.push(envelope(result.tenantId, 'openmap.reconciliation.conflict', observed.name, { type: observed.type, identity: observed.identity, ciIds: resolution.ciIds, matchedKeys: resolution.matchedKeys }));
      continue;
    }
    if (resolution.kind === 'new') {
      const id = randomUUID();
      const layer = CI_TYPE_LAYER[observed.type];
      const ci: Ci = {
        ...observed,
        id,
        tenantId: result.tenantId,
        displayName: observed.name,
        code: ciCode(layer, observed.type, observed.name),
        layer,
        userLabel: null,
        lifecycle: 'discovered',
        source,
        validFrom: observed.observedAt,
        validTo: null,
        checksum: checksum(observed.type, observed.identity, observed.attributes),
      };
      out.created.push(ci);
      for (const k of identityKeysOf(observed)) createdByKey.set(k, id);
      out.events.push(envelope(result.tenantId, 'openmap.ci.created', id, { type: ci.type, layer: ci.layer, name: ci.name, source }));
      continue;
    }
    const existing = lookup.getCi(resolution.ciId);
    if (!existing) continue;
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
    out.events.push(envelope(result.tenantId, 'openmap.ci.updated', updated.id, { changedKeys: merged.changedKeys, source: merged.source }));
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
    out.events.push(envelope(result.tenantId, 'openmap.relationship.created', created.id, { type: created.type, fromCiId: fromId, toCiId: toId }));
  }
  return out;
}

/** Observations from port scans and unknown classification are weaker than authenticated collectors. */
function confidenceFor(observed: ObservedCi): number {
  return observed.type === 'unknown' ? RECONCILIATION.overwriteMinConfidence : RECONCILIATION.discoveryDefaultConfidence;
}
