// REQ-DCIM-007 (ADR-061) — the Capacity view's query: a room's space, power, cooling and port capacity per rack with
// the power trend, as GraphQL `roomCapacity` returns it.
import { queryOptions } from '@tanstack/react-query';
import type { CapacityState } from '@openmap/contracts';
import { gql } from './graphql';

export interface CapacityCi {
  id: string;
  name: string;
  displayName: string;
  type: string;
  layer: string;
}

export interface SpaceCapacity {
  units: number;
  occupied: number;
  free: number;
  largestFreeBlock: number;
  freeBlocks: number[];
  percent: number | null;
}

export interface PowerCapacity {
  designWatts: number;
  loadWatts: number;
  percent: number | null;
  state: CapacityState;
  measuredAt: string | null;
}

export interface PortCapacity {
  total: number;
  used: number;
  free: number;
  percent: number | null;
}

export interface CoolingCapacity {
  capacityKw: number;
  loadKw: number;
  percent: number | null;
  state: CapacityState;
  units: number;
}

export interface CapacityTrend {
  days: number;
  points: number;
  slopeKwPerDay: number | null;
  daysToWarning: number | null;
  daysToCritical: number | null;
}

export interface RackCapacity {
  rack: CapacityCi;
  space: SpaceCapacity;
  power: PowerCapacity;
  ports: PortCapacity;
  state: CapacityState;
}

export interface RoomCapacity {
  room: CapacityCi;
  racks: RackCapacity[];
  space: SpaceCapacity;
  power: PowerCapacity;
  cooling: CoolingCapacity;
  ports: PortCapacity;
  trend: CapacityTrend;
  state: CapacityState;
}

const CI = 'id name displayName type layer';
const SPACE = 'units occupied free largestFreeBlock freeBlocks percent';
const POWER = 'designWatts loadWatts percent state measuredAt';
const PORTS = 'total used free percent';
const ROOM_CAPACITY_QUERY =
  'query RoomCapacity($roomId: UUID!) { roomCapacity(roomId: $roomId) { room { ' +
  CI +
  ' } racks { rack { ' +
  CI +
  ' } space { ' +
  SPACE +
  ' } power { ' +
  POWER +
  ' } ports { ' +
  PORTS +
  ' } state } space { ' +
  SPACE +
  ' } power { ' +
  POWER +
  ' } cooling { capacityKw loadKw percent state units } ports { ' +
  PORTS +
  ' } trend { days points slopeKwPerDay daysToWarning daysToCritical } state } }';

export const capacityKey = ['capacity'] as const;

export function roomCapacityQuery(roomId: string | null) {
  return queryOptions({
    queryKey: [...capacityKey, roomId] as const,
    queryFn: ({ signal }) =>
      gql<{ roomCapacity: RoomCapacity }>(ROOM_CAPACITY_QUERY, { roomId }, signal).then(
        (d) => d.roomCapacity,
      ),
    enabled: roomId !== null,
  });
}
