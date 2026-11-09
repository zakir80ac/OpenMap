// T-538 REQ-DCIM-006 (ADR-060) — the environmental contract: sensor positions read from probe names, inlet temperature
// and humidity against the ASHRAE A1 envelope, airflow from the rise across a rack, and the worst of several states.
import { ENVIRONMENT } from '@openmap/constants';
import { describe, expect, it } from 'vitest';
import { airflowState, humidityState, sensorPosition, temperatureState, worstState } from './environment.js';

describe('environmental contract', () => {
  it('reads a sensor position from its name', () => {
    expect(sensorPosition('Rack Inlet 1')).toBe('inlet');
    expect(sensorPosition('Exhaust Temp')).toBe('outlet');
    expect(sensorPosition('Supply Air')).toBe('supply');
    expect(sensorPosition('Return Air Temp')).toBe('return');
    expect(sensorPosition('Ambient')).toBe('room');
    expect(sensorPosition('Probe 3')).toBeNull();
  });

  it('bands temperature and humidity by the A1 envelope', () => {
    expect(temperatureState(22)).toBe('normal');
    expect(temperatureState(ENVIRONMENT.recommendedC.max + 1)).toBe('warning');
    expect(temperatureState(ENVIRONMENT.recommendedC.min - 1)).toBe('warning');
    expect(temperatureState(ENVIRONMENT.allowableC.max + 1)).toBe('critical');
    expect(temperatureState(null)).toBe('unknown');
    expect(humidityState(45)).toBe('normal');
    expect(humidityState(ENVIRONMENT.recommendedMaxRh + 5)).toBe('warning');
    expect(humidityState(ENVIRONMENT.allowableRh.max + 1)).toBe('critical');
    expect(humidityState(ENVIRONMENT.allowableRh.min - 1)).toBe('critical');
  });

  it('judges airflow from the rise across a rack and takes the worst state', () => {
    expect(airflowState(22, 34)).toBe('normal');
    expect(airflowState(22, 22 + ENVIRONMENT.maxRackRiseC + 1)).toBe('warning');
    expect(airflowState(22, null)).toBe('unknown');
    expect(worstState(['normal', 'warning', 'unknown'])).toBe('warning');
    expect(worstState(['normal', 'critical'])).toBe('critical');
    expect(worstState([])).toBe('unknown');
  });
});
