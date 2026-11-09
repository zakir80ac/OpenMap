// REQ-DCIM-004 (ADR-058) — a room's power chain as the DCIM Power view reads it, a PDU's cords by outlet, and the
// operator's cord changes.
import { queryOptions } from '@tanstack/react-query';
import type { PowerFindingKind } from '@openmap/contracts';
import { gql } from './graphql';

export interface PowerCi {
  id: string;
  name: string;
  type: string;
}

export interface PowerSource {
  ci: PowerCi;
  kind: 'ups' | 'power_circuit' | 'pdu';
  feed: string | null;
  ratedWatts: number | null;
  loadWatts: number | null;
  outlets: number | null;
  outletsUsed: number;
  runtimeMinutes: number | null;
  fedBy: PowerCi[];
  rack: PowerCi | null;
}

export interface PowerFinding {
  kind: PowerFindingKind;
  ci: PowerCi;
  partner: PowerCi | null;
  load: number | null;
  capacity: number | null;
}

export interface PowerChain {
  summary: {
    ups: number;
    circuits: number;
    pdus: number;
    devices: number;
    redundantDevices: number;
    findings: number;
  };
  sources: PowerSource[];
  findings: PowerFinding[];
}

export interface PowerConnection {
  id: string;
  device: PowerCi;
  pdu: PowerCi;
  feed: string | null;
  psu: number | null;
  outlet: number | null;
}

const CI = 'id name type';
const CHAIN_QUERY =
  'query PowerChain($roomId: UUID!) { powerChain(roomId: $roomId) { summary { ups circuits pdus devices redundantDevices findings } sources { ci { ' +
  CI +
  ' } kind feed ratedWatts loadWatts outlets outletsUsed runtimeMinutes fedBy { ' +
  CI +
  ' } rack { ' +
  CI +
  ' } } findings { kind ci { ' +
  CI +
  ' } partner { ' +
  CI +
  ' } load capacity } } }';
const CONNECTION = 'id device { ' + CI + ' } pdu { ' + CI + ' } feed psu outlet';

export const powerKey = ['power'] as const;

export function powerChainQuery(roomId: string | null) {
  return queryOptions({
    queryKey: [...powerKey, 'chain', roomId] as const,
    queryFn: ({ signal }) =>
      gql<{ powerChain: PowerChain }>(CHAIN_QUERY, { roomId }, signal).then((d) => d.powerChain),
    enabled: roomId !== null,
  });
}

export function pduConnectionsQuery(pduId: string | null) {
  return queryOptions({
    queryKey: [...powerKey, 'pdu', pduId] as const,
    queryFn: ({ signal }) =>
      gql<{ pduConnections: PowerConnection[] }>(
        'query PduConnections($pduId: UUID!) { pduConnections(pduId: $pduId) { ' + CONNECTION + ' } }',
        { pduId },
        signal,
      ).then((d) => d.pduConnections),
    enabled: pduId !== null,
  });
}

export function connectPower(input: {
  deviceId: string;
  pduId: string;
  outlet: number | null;
  psu: number | null;
}): Promise<PowerConnection> {
  return gql<{ connectPower: PowerConnection }>(
    'mutation ConnectPower($input: PowerConnectionInput!) { connectPower(input: $input) { ' +
      CONNECTION +
      ' } }',
    { input },
  ).then((d) => d.connectPower);
}

export function disconnectPower(id: string): Promise<boolean> {
  return gql<{ disconnectPower: boolean }>(
    'mutation DisconnectPower($id: UUID!) { disconnectPower(id: $id) }',
    { id },
  ).then((d) => d.disconnectPower);
}
