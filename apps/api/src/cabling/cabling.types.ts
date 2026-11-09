// REQ-DCIM-001 (ADR-056) — the cabling views the GraphQL types mirror. Endpoint and rack CIs are resolved by field
// resolvers through the request's CI loader, so a list of cables costs one batched read of their ends.
import type { CableKind, CableMedia, CircuitKind, CircuitStatus, PanelConnector, PanelSide } from '@openmap/contracts';
import type { CiRecord } from '../ci/ci.types.js';

export interface EndpointView {
  ciId: string;
  port: string | null;
  side: PanelSide | null;
}

export interface CableView {
  ci: CiRecord;
  label: string;
  kind: CableKind | null;
  media: CableMedia | null;
  lengthM: number | null;
  colour: string | null;
  a: EndpointView;
  b: EndpointView;
}

export interface PatchPanelPortView {
  position: number;
  front: CableView | null;
  rear: CableView | null;
  circuit: CircuitView | null;
}

export interface PatchPanelView {
  ci: CiRecord;
  rackCiId: string | null;
  name: string;
  ports: number;
  media: CableMedia | null;
  connector: PanelConnector | null;
  uPosition: number | null;
  used: number;
  positions: PatchPanelPortView[];
}

export interface CircuitView {
  ci: CiRecord;
  provider: string;
  circuitId: string;
  kind: CircuitKind | null;
  status: CircuitStatus | null;
  bandwidthMbps: number | null;
  aEnd: EndpointView | null;
  zEnd: EndpointView | null;
  zEndDescription: string | null;
}

export interface CablingView {
  summary: { patchPanels: number; positions: number; positionsUsed: number; cables: number; crossConnects: number; circuits: number };
  patchPanels: PatchPanelView[];
  cables: CableView[];
  circuits: CircuitView[];
}

export interface CableHopView {
  from: EndpointView;
  viaCiId: string;
  viaKind: 'cable' | 'circuit';
  to: EndpointView;
}

export interface CableTraceView {
  hops: CableHopView[];
  complete: boolean;
  looped: boolean;
}
