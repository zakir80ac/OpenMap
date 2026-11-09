// REQ-DCIM-001 (ADR-056) — structured cabling as CIs: patch panels mounted in racks, cables (patch leads, trunks and
// colocation cross-connects) and carrier circuits. A cable or circuit is `connected_to` each of its two ends; the
// relationship carries which end it is and, on a patch panel, the position and the side (front or rear). A patch panel
// position joins its front to its rear, so a trace from any port walks cable → panel → cable until it reaches a port
// that is not a panel: the far end of the path.
import { CABLING } from '@openmap/constants';
import { z } from 'zod';

export const CABLE_KINDS = ['patch', 'trunk', 'cross_connect'] as const;
export type CableKind = (typeof CABLE_KINDS)[number];
/** Copper categories, multimode (OM) and single-mode (OS) fibre, direct-attach and active optical, and coax. */
export const CABLE_MEDIA = ['cat5e', 'cat6', 'cat6a', 'cat8', 'om3', 'om4', 'om5', 'os2', 'dac', 'aoc', 'coax'] as const;
export type CableMedia = (typeof CABLE_MEDIA)[number];
export const PANEL_CONNECTORS = ['rj45', 'lc', 'sc', 'mpo', 'st', 'fc'] as const;
export type PanelConnector = (typeof PANEL_CONNECTORS)[number];
export const PANEL_SIDES = ['front', 'rear'] as const;
export type PanelSide = (typeof PANEL_SIDES)[number];
export const CIRCUIT_KINDS = ['internet', 'mpls', 'point_to_point', 'wavelength', 'dark_fibre', 'voice'] as const;
export type CircuitKind = (typeof CIRCUIT_KINDS)[number];
export const CIRCUIT_STATUSES = ['planned', 'provisioning', 'active', 'decommissioned'] as const;
export type CircuitStatus = (typeof CIRCUIT_STATUSES)[number];
/** The two ends of a cable (A, B) and of a circuit (A, Z). */
export const LINK_ENDS = ['A', 'B', 'Z'] as const;
export type LinkEnd = (typeof LINK_ENDS)[number];

/** Attribute names on the cabling CIs and on the `connected_to` relationships to their ends. */
export const CABLING_ATTRIBUTES = {
  kind: 'kind',
  media: 'media',
  connector: 'connector',
  ports: 'ports',
  uPosition: 'uPosition',
  lengthM: 'lengthM',
  colour: 'colour',
  provider: 'provider',
  circuitId: 'circuitId',
  bandwidthMbps: 'bandwidthMbps',
  status: 'status',
  zEndDescription: 'zEndDescription',
  /** On the relationship from a cable or circuit to one of its ends. */
  end: 'end',
  port: 'port',
  side: 'side',
} as const;

/** One end of a cable or circuit: a CI, the port on it (a panel position, or a device's port name) and a panel side. */
export interface CableEndpoint {
  ciId: string;
  port: string | null;
  side: PanelSide | null;
}

const PORT = z.string().trim().min(1).max(64);
export const cableEndpointSchema = z.object({
  ciId: z.uuid(),
  port: PORT.nullable(),
  side: z.enum(PANEL_SIDES).nullable(),
});

export const patchPanelInputSchema = z.object({
  rackId: z.uuid(),
  name: z.string().trim().min(1).max(64),
  ports: z.number().int().positive().max(CABLING.maxPanelPorts),
  media: z.enum(CABLE_MEDIA),
  connector: z.enum(PANEL_CONNECTORS),
  uPosition: z.number().int().positive().nullable(),
});
export type PatchPanelInput = z.infer<typeof patchPanelInputSchema>;

export const cableInputSchema = z
  .object({
    label: z.string().trim().min(1).max(64),
    kind: z.enum(CABLE_KINDS),
    media: z.enum(CABLE_MEDIA),
    lengthM: z.number().positive().nullable(),
    colour: z.string().trim().min(1).max(32).nullable(),
    a: cableEndpointSchema,
    b: cableEndpointSchema,
  })
  .refine((c) => endpointKey(c.a) !== endpointKey(c.b), { path: ['b'], message: 'a cable joins two different ports' });
export type CableInput = z.infer<typeof cableInputSchema>;

export const circuitInputSchema = z.object({
  provider: z.string().trim().min(1).max(128),
  circuitId: z.string().trim().min(1).max(128),
  kind: z.enum(CIRCUIT_KINDS),
  status: z.enum(CIRCUIT_STATUSES),
  bandwidthMbps: z.number().int().positive().nullable(),
  aEnd: cableEndpointSchema.nullable(),
  zEnd: cableEndpointSchema.nullable(),
  /** Where the far end is when it is not in OpenMap: the provider's POP, a branch address. */
  zEndDescription: z.string().trim().min(1).max(256).nullable(),
});
export type CircuitInput = z.infer<typeof circuitInputSchema>;

/** The key an endpoint is unique by: one cable per panel position and side, one per device port. */
export function endpointKey(e: CableEndpoint): string {
  return e.ciId + '|' + (e.port ?? '') + '|' + (e.side ?? '');
}

/**
 * An endpoint checked against its CI: on a patch panel it needs a position within the port count and a side; on every
 * other CI it has no side. Returns the problem, or null when the endpoint is valid.
 */
export function endpointProblem(e: CableEndpoint, panelPorts: number | null): string | null {
  if (panelPorts === null) return e.side === null ? null : 'only a patch panel position has a front and a rear';
  if (e.side === null) return 'a patch panel position needs a side (front or rear)';
  const position = Number(e.port);
  if (e.port === null || !Number.isInteger(position) || position < 1 || position > panelPorts)
    return 'a patch panel position is a number from 1 to ' + String(panelPorts);
  return null;
}

/** A cable or circuit with its two ends, as the trace walks it. */
export interface CableLink {
  id: string;
  via: 'cable' | 'circuit';
  a: CableEndpoint;
  b: CableEndpoint;
}

export interface CableHop {
  from: CableEndpoint;
  link: CableLink;
  to: CableEndpoint;
}

export interface CableTrace {
  hops: CableHop[];
  /** The path ends at a port that is not a patch panel position; false when it stops at a panel side with nothing patched. */
  complete: boolean;
  /** The trace came back to a port it had already passed (a mis-patch) or ran past CABLING.maxTraceHops. */
  looped: boolean;
}

function opposite(side: PanelSide): PanelSide {
  return side === 'front' ? 'rear' : 'front';
}

/**
 * Walks the path from `start`: the cable or circuit on that port to its other end; when that end is a patch panel
 * position, on through the panel to the same position's other side and the cable there. It stops at a non-panel end,
 * at a panel side with nothing patched, or on a loop.
 */
export function traceCable(start: CableEndpoint, links: readonly CableLink[], isPanel: (ciId: string) => boolean): CableTrace {
  const at = new Map<string, CableLink[]>();
  for (const link of links)
    for (const end of [link.a, link.b]) {
      const key = endpointKey(end);
      at.set(key, [...(at.get(key) ?? []), link]);
    }
  const hops: CableHop[] = [];
  const seen = new Set<string>();
  let here = start;
  for (;;) {
    const key = endpointKey(here);
    if (seen.has(key) || hops.length >= CABLING.maxTraceHops) return { hops, complete: false, looped: true };
    seen.add(key);
    const link = at.get(key)?.[0];
    if (link === undefined) return { hops, complete: hops.length > 0 && !isPanel(here.ciId), looped: false };
    const to = endpointKey(link.a) === key ? link.b : link.a;
    hops.push({ from: here, link, to });
    if (!isPanel(to.ciId) || to.side === null) return { hops, complete: true, looped: false };
    seen.add(endpointKey(to));
    here = { ciId: to.ciId, port: to.port, side: opposite(to.side) };
  }
}
