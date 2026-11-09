// T-532 REQ-DCIM-005 (ADR-059) — power monitoring in the contract: the energy of measured draw between samples only
// (trapezoid rule, nothing extrapolated outside the window or past the last sample), the state of a draw against a
// rating and the tenant's lines, and the settings rules (the critical line above the warning line, a tariff with its
// currency).
import { TIME } from '@openmap/constants';
import { describe, expect, it } from 'vitest';
import { energyOf, powerSettingsSchema, powerState } from './power.js';

const H = TIME.msPerHour;

describe('power monitoring contract', () => {
  it('integrates measured draw between samples inside the window', () => {
    const samples = [
      { at: 0, watts: 1_000 },
      { at: 2 * H, watts: 3_000 },
      { at: 4 * H, watts: 3_000 },
      { at: 10 * H, watts: 9_000 },
    ];
    expect(energyOf(samples, 0, 4 * H)).toEqual({ kwh: 10, coveredHours: 4, samples: 3 });
    // A window reaching past the last sample is not filled in.
    expect(energyOf(samples.slice(0, 3), 0, 24 * H)).toEqual({ kwh: 10, coveredHours: 4, samples: 3 });
    expect(energyOf([{ at: H, watts: 500 }], 0, 2 * H)).toEqual({ kwh: 0, coveredHours: 0, samples: 1 });
  });

  it('bands a draw against its rating and the lines', () => {
    const lines = { warnPercent: 70, criticalPercent: 90 };
    expect(powerState(6_000, 10_000, lines)).toBe('normal');
    expect(powerState(7_000, 10_000, lines)).toBe('warning');
    expect(powerState(9_500, 10_000, lines)).toBe('critical');
    expect(powerState(null, 10_000, lines)).toBe('unknown');
    expect(powerState(5_000, null, lines)).toBe('unknown');
  });

  it('requires the critical line above the warning line and a currency with a tariff', () => {
    expect(powerSettingsSchema.safeParse({ warnPercent: 70, criticalPercent: 90, tariffPerKwh: 0.18, currency: 'SAR' }).success).toBe(true);
    expect(powerSettingsSchema.safeParse({ warnPercent: 70, criticalPercent: 90, tariffPerKwh: null, currency: null }).success).toBe(true);
    expect(powerSettingsSchema.safeParse({ warnPercent: 90, criticalPercent: 70, tariffPerKwh: null, currency: null }).success).toBe(false);
    expect(powerSettingsSchema.safeParse({ warnPercent: 70, criticalPercent: 90, tariffPerKwh: 0.18, currency: null }).success).toBe(false);
  });
});
