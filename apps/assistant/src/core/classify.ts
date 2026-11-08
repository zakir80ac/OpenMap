// REQ-AI-002 — classification of unknown CIs: a pure scorer over the evidence a port scan leaves on a CI (SNMP
// sysDescr, HTTP banner, OUI vendor, open ports) against DEVICE_FINGERPRINTS. The best fingerprint above
// CLASSIFICATION.minConfidence becomes a suggestion: a device class, the layer and (where the CMDB has one) the type,
// and the label a person accepts or dismisses. Every point of the score is evidence the person can see.
import { CLASSIFICATION, DEVICE_FINGERPRINTS } from '@openmap/constants';
import { CI_LAYERS, CI_TYPES, type CiLayer, type CiType } from '@openmap/contracts';

export type DeviceClass = (typeof DEVICE_FINGERPRINTS)[number]['deviceClass'];
export const DEVICE_CLASSES: readonly DeviceClass[] = DEVICE_FINGERPRINTS.map((f) => f.deviceClass);

export type ClassificationSignal = 'sysDescr' | 'banner' | 'vendor' | 'ports';

export interface ClassificationEvidence {
  signal: ClassificationSignal;
  /** What matched: the text the pattern found, or the ports. */
  value: string;
  weight: number;
}

export interface ClassificationInput {
  name: string;
  attributes: Record<string, unknown>;
}

export interface CiClassification {
  deviceClass: DeviceClass;
  layer: CiLayer;
  type: CiType | null;
  /** 0 to 1: the summed weight of the evidence that matched. */
  confidence: number;
  evidence: ClassificationEvidence[];
  /** The label's title: the device's own description, else its name. */
  title: string;
  /** The label's description: the evidence, as data the person can check. */
  description: string;
}

/** The attribute names collectors use for each kind of evidence; the first present wins. */
const EVIDENCE_ATTRIBUTES: Record<Exclude<ClassificationSignal, 'ports'>, readonly string[]> = {
  sysDescr: ['sysDescr', 'description', 'snmpDescription'],
  banner: ['httpBanner', 'banner', 'serverHeader'],
  vendor: ['vendorFromOui', 'ouiVendor', 'vendor', 'manufacturer'],
};
const PORT_ATTRIBUTES = ['openPorts', 'ports'] as const;

function text(attributes: Record<string, unknown>, names: readonly string[]): string | null {
  for (const name of names) {
    const v = attributes[name];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

function ports(attributes: Record<string, unknown>): number[] {
  for (const name of PORT_ATTRIBUTES) {
    const v = attributes[name];
    if (Array.isArray(v)) return v.map(Number).filter((p) => Number.isInteger(p));
  }
  return [];
}

const PATTERNS = DEVICE_FINGERPRINTS.map((f) => ({
  fingerprint: f,
  sysDescr: new RegExp(f.sysDescr, 'iu'),
  banner: new RegExp(f.banner, 'iu'),
  vendor: new RegExp(f.vendor, 'iu'),
}));

const LAYERS: ReadonlySet<string> = new Set(CI_LAYERS);
const TYPES: ReadonlySet<string> = new Set(CI_TYPES);

/** The best-scoring fingerprint for a CI, or null when no fingerprint reaches CLASSIFICATION.minConfidence. */
export function classifyCi(ci: ClassificationInput): CiClassification | null {
  const evidence = {
    sysDescr: text(ci.attributes, EVIDENCE_ATTRIBUTES.sysDescr),
    banner: text(ci.attributes, EVIDENCE_ATTRIBUTES.banner),
    vendor: text(ci.attributes, EVIDENCE_ATTRIBUTES.vendor),
  };
  const open = ports(ci.attributes);
  let best: CiClassification | null = null;
  for (const p of PATTERNS) {
    const found: ClassificationEvidence[] = [];
    for (const signal of ['sysDescr', 'banner', 'vendor'] as const) {
      const value = evidence[signal];
      const match = value === null ? null : p[signal].exec(value);
      if (match !== null) found.push({ signal, value: match[0], weight: CLASSIFICATION.weights[signal] });
    }
    const signature = p.fingerprint.ports.filter((port) => open.includes(port));
    if (signature.length > 0)
      found.push({ signal: 'ports', value: signature.join(', '), weight: (CLASSIFICATION.weights.ports * signature.length) / p.fingerprint.ports.length });
    const confidence = found.reduce((n, e) => n + e.weight, 0);
    if (confidence < CLASSIFICATION.minConfidence || (best !== null && confidence <= best.confidence)) continue;
    const f = p.fingerprint;
    if (!LAYERS.has(f.layer) || (f.type !== null && !TYPES.has(f.type))) continue;
    best = {
      deviceClass: f.deviceClass,
      layer: f.layer as CiLayer,
      type: f.type as CiType | null,
      confidence: Number(confidence.toFixed(CLASSIFICATION.confidenceDecimals)),
      evidence: found,
      title: (evidence.sysDescr ?? ci.name).slice(0, CLASSIFICATION.titleChars),
      description: found.map((e) => e.signal + ': ' + e.value).join('; '),
    };
  }
  return best;
}
