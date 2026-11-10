// REQ-DCIM-001 REQ-DCIM-008 (ADR-056, ADR-062) — structured cabling as the DCIM Cabling tab reads and writes it: patch panels with their
// positions, cables, cross-connects and circuits, the trace from a port, and the operator's changes.
import { queryOptions } from '@tanstack/react-query';
import type {
  CableKind,
  CableMedia,
  CableVerificationReason,
  CableVerificationStatus,
  CircuitKind,
  CircuitStatus,
  PanelConnector,
  PanelSide,
} from '@openmap/contracts';
import { gql } from './graphql';

export interface CablingCi {
  id: string;
  name: string;
  type: string;
}

export interface CableEnd {
  ci: CablingCi;
  port: string | null;
  side: PanelSide | null;
}

export interface Cable {
  ci: { id: string };
  label: string;
  kind: CableKind | null;
  media: CableMedia | null;
  lengthM: number | null;
  colour: string | null;
  a: CableEnd;
  b: CableEnd;
}

export interface PanelPosition {
  position: number;
  front: { ci: { id: string }; label: string } | null;
  rear: { ci: { id: string }; label: string } | null;
  circuit: { ci: { id: string }; circuitId: string } | null;
}

export interface PatchPanel {
  ci: CablingCi;
  rack: { id: string; name: string } | null;
  name: string;
  ports: number;
  media: CableMedia | null;
  connector: PanelConnector | null;
  uPosition: number | null;
  used: number;
  positions: PanelPosition[];
}

export interface Circuit {
  ci: { id: string };
  provider: string;
  circuitId: string;
  kind: CircuitKind | null;
  status: CircuitStatus | null;
  bandwidthMbps: number | null;
  aEnd: CableEnd | null;
  zEnd: CableEnd | null;
  zEndDescription: string | null;
}

export interface Cabling {
  summary: {
    patchPanels: number;
    positions: number;
    positionsUsed: number;
    cables: number;
    crossConnects: number;
    circuits: number;
  };
  patchPanels: PatchPanel[];
  cables: Cable[];
  circuits: Circuit[];
}

export interface CableHop {
  from: CableEnd;
  via: { id: string; name: string };
  viaKind: 'cable' | 'circuit';
  to: CableEnd;
}

export interface CableTrace {
  hops: CableHop[];
  complete: boolean;
  looped: boolean;
}

export interface EndpointInput {
  ciId: string;
  port: string | null;
  side: PanelSide | null;
}

const END = 'ci { id name type } port side';
const CABLE = 'ci { id } label kind media lengthM colour a { ' + END + ' } b { ' + END + ' }';
const CIRCUIT =
  'ci { id } provider circuitId kind status bandwidthMbps aEnd { ' +
  END +
  ' } zEnd { ' +
  END +
  ' } zEndDescription';
const PANEL =
  'ci { id name type } rack { id name } name ports media connector uPosition used positions { position front { ci { id } label } rear { ci { id } label } circuit { ci { id } circuitId } }';
const CABLING_QUERY =
  'query Cabling { cabling { summary { patchPanels positions positionsUsed cables crossConnects circuits } patchPanels { ' +
  PANEL +
  ' } cables { ' +
  CABLE +
  ' } circuits { ' +
  CIRCUIT +
  ' } } }';

export const cablingKey = ['cabling'] as const;

export function cablingQuery() {
  return queryOptions({
    queryKey: cablingKey,
    queryFn: ({ signal }) =>
      gql<{ cabling: Cabling }>(CABLING_QUERY, undefined, signal).then((d) => d.cabling),
  });
}

export function cableTraceQuery(endpoint: EndpointInput | null) {
  return queryOptions({
    queryKey: ['cable-trace', endpoint] as const,
    queryFn: ({ signal }) =>
      gql<{ cableTrace: CableTrace }>(
        'query CableTrace($endpoint: CableEndpointInput!) { cableTrace(endpoint: $endpoint) { complete looped hops { viaKind via { id name } from { ' +
          END +
          ' } to { ' +
          END +
          ' } } } }',
        { endpoint },
        signal,
      ).then((d) => d.cableTrace),
    enabled: endpoint !== null,
  });
}

export interface PatchPanelInput {
  rackId: string;
  name: string;
  ports: number;
  media: CableMedia;
  connector: PanelConnector;
  uPosition: number | null;
}

export interface CableInput {
  label: string;
  kind: CableKind;
  media: CableMedia;
  lengthM: number | null;
  colour: string | null;
  a: EndpointInput;
  b: EndpointInput;
}

export interface CircuitInput {
  provider: string;
  circuitId: string;
  kind: CircuitKind;
  status: CircuitStatus;
  bandwidthMbps: number | null;
  aEnd: EndpointInput | null;
  zEnd: EndpointInput | null;
  zEndDescription: string | null;
}

export function savePatchPanel(input: PatchPanelInput): Promise<PatchPanel> {
  return gql<{ upsertPatchPanel: PatchPanel }>(
    'mutation SavePatchPanel($input: PatchPanelInput!) { upsertPatchPanel(input: $input) { ' + PANEL + ' } }',
    { input },
  ).then((d) => d.upsertPatchPanel);
}

export function connectCable(input: CableInput): Promise<Cable> {
  return gql<{ connectCable: Cable }>(
    'mutation ConnectCable($input: CableInput!) { connectCable(input: $input) { ' + CABLE + ' } }',
    { input },
  ).then((d) => d.connectCable);
}

export function disconnectCable(id: string): Promise<boolean> {
  return gql<{ disconnectCable: boolean }>(
    'mutation DisconnectCable($id: UUID!) { disconnectCable(id: $id) }',
    { id },
  ).then((d) => d.disconnectCable);
}

export function saveCircuit(input: CircuitInput): Promise<Circuit> {
  return gql<{ upsertCircuit: Circuit }>(
    'mutation SaveCircuit($input: CircuitInput!) { upsertCircuit(input: $input) { ' + CIRCUIT + ' } }',
    { input },
  ).then((d) => d.upsertCircuit);
}

export function removePatchPanel(id: string): Promise<boolean> {
  return gql<{ removePatchPanel: boolean }>(
    'mutation RemovePatchPanel($id: UUID!) { removePatchPanel(id: $id) }',
    { id },
  ).then((d) => d.removePatchPanel);
}

export function removeCircuit(id: string): Promise<boolean> {
  return gql<{ removeCircuit: boolean }>('mutation RemoveCircuit($id: UUID!) { removeCircuit(id: $id) }', {
    id,
  }).then((d) => d.removeCircuit);
}

// REQ-DCIM-008 (ADR-062) — cable verification: each recorded cable judged against the adjacencies discovery observed,
// the observed links no cable explains, and the printable labels.
export interface ObservedPort {
  ci: CablingCi;
  port: string | null;
}

export interface ObservedLink {
  a: ObservedPort;
  b: ObservedPort;
  protocol: string | null;
  media: string | null;
  speedMbps: number | null;
  suggestedLabel: string;
}

export interface CableVerification {
  cable: { ci: { id: string }; label: string };
  status: CableVerificationStatus;
  reason: CableVerificationReason;
  observed: ObservedLink | null;
}

export interface CablingVerification {
  summary: {
    cables: number;
    verified: number;
    mismatch: number;
    unobserved: number;
    unverifiable: number;
    undocumented: number;
  };
  cables: CableVerification[];
  undocumented: ObservedLink[];
}

const OBSERVED_PORT = 'ci { id name type } port';
const OBSERVED_LINK =
  'a { ' + OBSERVED_PORT + ' } b { ' + OBSERVED_PORT + ' } protocol media speedMbps suggestedLabel';
const VERIFICATION_QUERY =
  'query CablingVerification { cablingVerification { summary { cables verified mismatch unobserved unverifiable undocumented } cables { cable { ci { id } label } status reason observed { ' +
  OBSERVED_LINK +
  ' } } undocumented { ' +
  OBSERVED_LINK +
  ' } } }';

/** Under the cabling key, so every cabling change re-reads the verdicts with the cables. */
export const cablingVerificationKey = [...cablingKey, 'verification'] as const;

export function cablingVerificationQuery() {
  return queryOptions({
    queryKey: cablingVerificationKey,
    queryFn: ({ signal }) =>
      gql<{ cablingVerification: CablingVerification }>(VERIFICATION_QUERY, undefined, signal).then(
        (d) => d.cablingVerification,
      ),
  });
}

export function fetchCablingLabelsCsv(): Promise<string> {
  return gql<{ cablingLabelsCsv: string }>('query CablingLabelsCsv { cablingLabelsCsv }', undefined).then(
    (d) => d.cablingLabelsCsv,
  );
}
