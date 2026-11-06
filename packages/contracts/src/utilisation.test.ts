// T-202 REQ-CMDB-034 — utilisation metric names per CI type follow the metric naming convention, map back to their
// measure, and a CI's latest values classify as hot, idle, normal or unknown.
import { describe, expect, it } from 'vitest';
import { METRIC_NAME_PATTERN } from './ci.js';
import { UTILISATION_CI_TYPES, UTILISATION_METRIC_NAMES, UTILISATION_METRICS, measureOfMetric, utilisationState } from './utilisation.js';

const thresholds = { hotPercent: 85, idlePercent: 10 };

describe('utilisation', () => {
  it('names metrics by convention and maps them back', () => {
    for (const name of UTILISATION_METRIC_NAMES) expect(name).toMatch(METRIC_NAME_PATTERN);
    expect(UTILISATION_CI_TYPES).toEqual(expect.arrayContaining(['host', 'vm', 'pdu']));
    expect(UTILISATION_METRICS.host?.power?.unit).toBe('W');
    expect(measureOfMetric('vm.memory.utilisation_percent')).toBe('memory');
    expect(measureOfMetric('dcim.power.watts')).toBe('power');
    expect(measureOfMetric('app.apdex.score')).toBeNull();
  });

  it('classifies hot, idle, normal and unknown', () => {
    expect(utilisationState({ cpu: 90, memory: 20 }, thresholds)).toBe('hot');
    expect(utilisationState({ cpu: 20, memory: 40, disk: 92 }, thresholds)).toBe('hot');
    expect(utilisationState({ cpu: 4, memory: 9 }, thresholds)).toBe('idle');
    expect(utilisationState({ cpu: 4 }, thresholds)).toBe('normal');
    expect(utilisationState({ cpu: 40, memory: 60 }, thresholds)).toBe('normal');
    expect(utilisationState({ power: 300 }, thresholds)).toBe('unknown');
  });
});
