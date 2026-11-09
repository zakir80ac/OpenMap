// REQ-DCIM-006 (ADR-060) — a room's environment as the DCIM Environment view reads it.
import { queryOptions } from '@tanstack/react-query';
import type { EnvState } from '@openmap/contracts';
import { gql } from './graphql';

export interface RackEnvironment {
  rack: { id: string; name: string };
  inletC: number | null;
  outletC: number | null;
  riseC: number | null;
  latestAt: string | null;
  temperatureState: EnvState;
  airflowState: EnvState;
  state: EnvState;
  inletSeries: Array<{ at: string; value: number }>;
}

export interface CoolingEnvironment {
  unit: { id: string; name: string };
  supplyC: number | null;
  returnC: number | null;
  humidityRh: number | null;
  capacityPercent: number | null;
  state: EnvState;
}

export interface RoomEnvironment {
  humidityRh: number | null;
  humidityState: EnvState;
  racks: RackEnvironment[];
  coolingUnits: CoolingEnvironment[];
  summary: {
    racks: number;
    normal: number;
    warning: number;
    critical: number;
    unknown: number;
    hottestInletC: number | null;
  };
}

const QUERY =
  'query RoomEnvironment($roomId: UUID!, $hours: Int!) { roomEnvironment(roomId: $roomId, hours: $hours) { humidityRh humidityState ' +
  'summary { racks normal warning critical unknown hottestInletC } ' +
  'racks { rack { id name } inletC outletC riseC latestAt temperatureState airflowState state inletSeries { at value } } ' +
  'coolingUnits { unit { id name } supplyC returnC humidityRh capacityPercent state } } }';

export function roomEnvironmentQuery(roomId: string | null, hours: number) {
  return queryOptions({
    queryKey: ['environment', roomId, hours] as const,
    queryFn: ({ signal }) =>
      gql<{ roomEnvironment: RoomEnvironment }>(QUERY, { roomId, hours }, signal).then(
        (d) => d.roomEnvironment,
      ),
    enabled: roomId !== null,
  });
}
