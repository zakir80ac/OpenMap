// REQ-CORE-013 — strips control characters collectors may capture from banners, descriptions and
// SNMP strings. Postgres jsonb rejects U+0000 outright, and the console never needs C0 controls, so
// every observed string is cleaned once here before identity, checksum or persistence see it.
import type { CollectorResult, MetricSample, ObservedCi, ObservedRelationship } from '@openmap/contracts';

// C0 controls except tab, newline and carriage return, plus DEL.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

export function sanitizeString(value: string): string {
  return value.replace(CONTROL_CHARS, '');
}

export function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[sanitizeString(k)] = sanitizeValue(v);
    return out;
  }
  return value;
}

function sanitizeIdentity(identity: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(identity)) out[sanitizeString(k)] = sanitizeString(v);
  return out;
}

function sanitizeRef(ref: ObservedRelationship['from']): ObservedRelationship['from'] {
  if ('id' in ref) return ref;
  return { ...ref, identity: sanitizeIdentity(ref.identity) };
}

export function sanitizeCi(ci: ObservedCi): ObservedCi {
  return {
    ...ci,
    identity: sanitizeIdentity(ci.identity),
    name: sanitizeString(ci.name),
    attributes: sanitizeValue(ci.attributes) as ObservedCi['attributes'],
    tags: ci.tags.map(sanitizeString),
  };
}

export function sanitizeRelationship(rel: ObservedRelationship): ObservedRelationship {
  return { ...rel, from: sanitizeRef(rel.from), to: sanitizeRef(rel.to), attributes: sanitizeValue(rel.attributes) as ObservedRelationship['attributes'] };
}

export function sanitizeSample(sample: MetricSample): MetricSample {
  return { ...sample, ci: sanitizeRef(sample.ci), unit: sanitizeString(sample.unit), labels: sanitizeIdentity(sample.labels) };
}

/** Returns a copy of the result with every observed string cleaned; the input is not mutated. */
export function sanitizeResult(result: CollectorResult): CollectorResult {
  return {
    ...result,
    cis: result.cis.map(sanitizeCi),
    relationships: result.relationships.map(sanitizeRelationship),
    samples: result.samples.map(sanitizeSample),
    errors: result.errors.map((e) => ({ ...e, message: sanitizeString(e.message) })),
  };
}
