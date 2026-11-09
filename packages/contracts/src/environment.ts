// REQ-DCIM-006 (ADR-060) — environmental monitoring: temperature, humidity and airflow. Readings are samples on the CI
// they describe: a rack's inlet and outlet sensors on the rack (label `position`), a cooling unit's supply and return
// air, humidity and cooling capacity on the cooling unit, a room's humidity on the room. States follow the ASHRAE A1
// envelope (ENVIRONMENT); airflow is judged from the temperature rise across a rack (outlet − inlet).
import { ENVIRONMENT } from '@openmap/constants';

export const ENV_METRICS = {
  temperature: 'dcim.env.temperature_c',
  humidity: 'dcim.env.humidity_rh',
  coolingCapacity: 'dcim.cooling.capacity_percent',
} as const;

/** Where a sensor sits: a rack's front (inlet) or back (outlet), a cooling unit's supply or return air, the room. */
export const SENSOR_POSITIONS = ['inlet', 'outlet', 'supply', 'return', 'room'] as const;
export type SensorPosition = (typeof SENSOR_POSITIONS)[number];
export const ENV_STATES = ['normal', 'warning', 'critical', 'unknown'] as const;
export type EnvState = (typeof ENV_STATES)[number];
const SEVERITY: Record<EnvState, number> = { unknown: 0, normal: 1, warning: 2, critical: 3 };

/**
 * The position a sensor's name states, the way vendors name probes ("Rack Inlet 1", "Supply Air", "Return Air Temp",
 * "Exhaust"); null when the name says nothing.
 */
export function sensorPosition(name: string): SensorPosition | null {
  const n = name.toLowerCase();
  if (/inlet|intake|front/u.test(n)) return 'inlet';
  if (/outlet|exhaust|rear|back/u.test(n)) return 'outlet';
  if (/supply|discharge/u.test(n)) return 'supply';
  if (/return/u.test(n)) return 'return';
  if (/room|ambient/u.test(n)) return 'room';
  return null;
}

/** The state of an inlet temperature: recommended range normal, allowable range warning, outside it critical. */
export function temperatureState(c: number | null): EnvState {
  if (c === null) return 'unknown';
  if (c < ENVIRONMENT.allowableC.min || c > ENVIRONMENT.allowableC.max) return 'critical';
  return c < ENVIRONMENT.recommendedC.min || c > ENVIRONMENT.recommendedC.max ? 'warning' : 'normal';
}

/** The state of a relative humidity: outside the allowable range critical, above the recommended limit a warning. */
export function humidityState(rh: number | null): EnvState {
  if (rh === null) return 'unknown';
  if (rh < ENVIRONMENT.allowableRh.min || rh > ENVIRONMENT.allowableRh.max) return 'critical';
  return rh > ENVIRONMENT.recommendedMaxRh ? 'warning' : 'normal';
}

/** Airflow across a rack: a rise over ENVIRONMENT.maxRackRiseC is a warning; unknown without both readings. */
export function airflowState(inletC: number | null, outletC: number | null): EnvState {
  if (inletC === null || outletC === null) return 'unknown';
  return outletC - inletC > ENVIRONMENT.maxRackRiseC ? 'warning' : 'normal';
}

/** The worse of several states (critical over warning over normal over unknown). */
export function worstState(states: readonly EnvState[]): EnvState {
  return states.reduce<EnvState>((worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst), 'unknown');
}
