// REQ-DCIM-008 (ADR-062) — cable verification: what people recorded (ADR-056 cables, traced through panels to the
// device ports at each end) against what discovery observed (LLDP and CDP adjacencies between switch ports, a server
// NIC seen on a switch port). Pure functions over normalised port references, so the API and the tests share one
// verdict. A recorded cable is verified when an observed link joins its two far ends, a mismatch when an end is
// observed on a different far end, unobserved when neither end has an observation, and unverifiable when its path
// does not reach two device ports. An observed link no recorded path explains is undocumented.
import { CABLING } from '@openmap/constants';

export const CABLE_VERIFICATION_STATUSES = ['verified', 'mismatch', 'unobserved', 'unverifiable'] as const;
export type CableVerificationStatus = (typeof CABLE_VERIFICATION_STATUSES)[number];

export const CABLE_VERIFICATION_REASONS = [
  'observed',
  'far_end_differs',
  'no_observation',
  'path_incomplete',
  'end_not_a_port',
] as const;
export type CableVerificationReason = (typeof CABLE_VERIFICATION_REASONS)[number];

/** A device and the port on it; a null port means the device as a whole (a cable recorded to a device, not a port). */
export interface PortRef {
  ciId: string;
  port: string | null;
}

export interface ObservedLink {
  a: PortRef;
  b: PortRef;
  /** lldp, cdp or the collector's word for how the adjacency was seen. */
  protocol: string | null;
  media: string | null;
  speedMbps: number | null;
}

/** A recorded cable after tracing: the device ports at each end of its path, or null when the path does not reach one. */
export interface RecordedPath {
  cableId: string;
  a: PortRef | null;
  b: PortRef | null;
  complete: boolean;
}

export interface CableVerdict {
  cableId: string;
  status: CableVerificationStatus;
  reason: CableVerificationReason;
  /** The observed link that confirmed or contradicted the cable, when one did. */
  observed: ObservedLink | null;
}

export interface CablingVerdicts {
  verdicts: CableVerdict[];
  /** Observed links no recorded path explains, each once whichever way round it was observed. */
  undocumented: ObservedLink[];
}

function normalisePort(port: string | null): string | null {
  const p = port?.trim().toLowerCase() ?? '';
  return p === '' ? null : p;
}

/** Two port references name the same place: same device, and the same port when both name one. */
export function samePort(x: PortRef, y: PortRef): boolean {
  if (x.ciId !== y.ciId) return false;
  const px = normalisePort(x.port);
  const py = normalisePort(y.port);
  return px === null || py === null || px === py;
}

/** A key for an observed link that is the same whichever end was reported first. */
export function linkKey(link: ObservedLink): string {
  const ends = [link.a, link.b].map((e) => e.ciId + '|' + (normalisePort(e.port) ?? '*')).sort();
  return ends.join('>');
}

function touches(link: ObservedLink, end: PortRef): PortRef | null {
  if (samePort(link.a, end)) return link.b;
  if (samePort(link.b, end)) return link.a;
  return null;
}

/** Verdicts for every recorded path and the observed links nothing recorded explains. */
export function verifyCabling(
  paths: readonly RecordedPath[],
  observed: readonly ObservedLink[],
): CablingVerdicts {
  const unique = new Map<string, ObservedLink>();
  for (const link of observed) if (!unique.has(linkKey(link))) unique.set(linkKey(link), link);
  const links = [...unique.values()];
  // By device: a tenant holds tens of thousands of adjacencies, and a path only ever concerns its two devices.
  const byDevice = new Map<string, ObservedLink[]>();
  // Appended in place: a core switch has thousands of links, and copying its list per link would be quadratic.
  for (const link of links)
    for (const ciId of new Set([link.a.ciId, link.b.ciId])) {
      const list = byDevice.get(ciId);
      if (list === undefined) byDevice.set(ciId, [link]);
      else list.push(link);
    }
  const explained = new Set<string>();
  const verdicts: CableVerdict[] = paths.map((path) => {
    if (!path.complete)
      return { cableId: path.cableId, status: 'unverifiable', reason: 'path_incomplete', observed: null };
    if (path.a === null || path.b === null)
      return { cableId: path.cableId, status: 'unverifiable', reason: 'end_not_a_port', observed: null };
    const a = path.a;
    const b = path.b;
    const atA = byDevice.get(a.ciId) ?? [];
    const atB = byDevice.get(b.ciId) ?? [];
    const confirming = atA.find((l) => {
      const far = touches(l, a);
      return far !== null && samePort(far, b);
    });
    if (confirming !== undefined) {
      explained.add(linkKey(confirming));
      return { cableId: path.cableId, status: 'verified', reason: 'observed', observed: confirming };
    }
    const contradicting = atA.find((l) => touches(l, a) !== null) ?? atB.find((l) => touches(l, b) !== null);
    if (contradicting !== undefined)
      return {
        cableId: path.cableId,
        status: 'mismatch',
        reason: 'far_end_differs',
        observed: contradicting,
      };
    return { cableId: path.cableId, status: 'unobserved', reason: 'no_observation', observed: null };
  });
  return { verdicts, undocumented: links.filter((l) => !explained.has(linkKey(l))) };
}

/** The label a cable gets when recorded from an observed link: both ends, device and port, within the label length. */
export function suggestedCableLabel(
  aName: string,
  aPort: string | null,
  bName: string,
  bPort: string | null,
): string {
  const end = (name: string, port: string | null): string => (port === null ? name : name + ':' + port);
  const label = end(aName, aPort) + ' - ' + end(bName, bPort);
  return label.length > CABLING.labelMaxChars ? label.slice(0, CABLING.labelMaxChars) : label;
}

export interface VerificationSummary {
  cables: number;
  verified: number;
  mismatch: number;
  unobserved: number;
  unverifiable: number;
  undocumented: number;
}

export function summariseVerdicts(result: CablingVerdicts): VerificationSummary {
  const count = (status: CableVerificationStatus): number =>
    result.verdicts.filter((v) => v.status === status).length;
  return {
    cables: result.verdicts.length,
    verified: count('verified'),
    mismatch: count('mismatch'),
    unobserved: count('unobserved'),
    unverifiable: count('unverifiable'),
    undocumented: result.undocumented.length,
  };
}
