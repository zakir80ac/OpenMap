// REQ-IPAM-004 (ADR-063) — switch ports as the IPAM "Switch ports" tab reads them: a device's ports with state, VLAN,
// neighbour and learned MACs, a port's history, and where a MAC has been seen.
import { queryOptions } from '@tanstack/react-query';
import type { PortState } from '@openmap/contracts';
import { gql } from './graphql';

export interface PortCi {
  id: string;
  name: string;
  displayName: string;
  type: string;
}

export interface LearnedMac {
  mac: string;
  ip: string | null;
  owner: PortCi | null;
}

export interface SwitchPort {
  port: PortCi;
  name: string;
  alias: string | null;
  state: PortState;
  speedMbps: number | null;
  mtu: number | null;
  vlan: number | null;
  learnedMacs: LearnedMac[];
  learnedMacCount: number;
  neighbour: { ci: PortCi; port: string | null; protocol: string | null } | null;
  lastChange: string | null;
  daysNotUp: number | null;
  unused: boolean;
}

export interface SwitchPorts {
  device: PortCi;
  summary: {
    ports: number;
    up: number;
    down: number;
    adminDown: number;
    unknown: number;
    unused: number;
    learnedMacs: number;
  };
  ports: SwitchPort[];
}

export interface PortChange {
  at: string;
  key: string;
  from: string | null;
  to: string | null;
}

export interface PortHistory {
  port: PortCi;
  days: number;
  versions: number;
  changes: PortChange[];
}

export type MacSightingKind = 'learned_on_port' | 'arp' | 'owner';

export interface MacLookup {
  mac: string;
  sightings: Array<{
    kind: MacSightingKind;
    ci: PortCi;
    port: string | null;
    ip: string | null;
    seenAt: string;
  }>;
}

const CI = 'id name displayName type';
const SWITCH_PORTS_QUERY =
  'query SwitchPorts($deviceId: UUID!) { switchPorts(deviceId: $deviceId) { device { ' +
  CI +
  ' } summary { ports up down adminDown unknown unused learnedMacs } ports { port { ' +
  CI +
  ' } name alias state speedMbps mtu vlan learnedMacs { mac ip owner { ' +
  CI +
  ' } } learnedMacCount neighbour { ci { ' +
  CI +
  ' } port protocol } lastChange daysNotUp unused } } }';
const PORT_HISTORY_QUERY =
  'query PortHistory($portId: UUID!) { portHistory(portId: $portId) { port { ' +
  CI +
  ' } days versions changes { at key from to } } }';
const MAC_LOOKUP_QUERY =
  'query MacLookup($mac: String!) { macLookup(mac: $mac) { mac sightings { kind ci { ' +
  CI +
  ' } port ip seenAt } } }';

export const switchPortsKey = ['switch-ports'] as const;

export function switchPortsQuery(deviceId: string | null) {
  return queryOptions({
    queryKey: [...switchPortsKey, 'device', deviceId] as const,
    queryFn: ({ signal }) =>
      gql<{ switchPorts: SwitchPorts }>(SWITCH_PORTS_QUERY, { deviceId }, signal).then((d) => d.switchPorts),
    enabled: deviceId !== null,
  });
}

export function portHistoryQuery(portId: string | null) {
  return queryOptions({
    queryKey: [...switchPortsKey, 'history', portId] as const,
    queryFn: ({ signal }) =>
      gql<{ portHistory: PortHistory }>(PORT_HISTORY_QUERY, { portId }, signal).then((d) => d.portHistory),
    enabled: portId !== null,
  });
}

export function macLookupQuery(mac: string | null) {
  return queryOptions({
    queryKey: [...switchPortsKey, 'mac', mac] as const,
    queryFn: ({ signal }) =>
      gql<{ macLookup: MacLookup }>(MAC_LOOKUP_QUERY, { mac }, signal).then((d) => d.macLookup),
    enabled: mac !== null,
  });
}
