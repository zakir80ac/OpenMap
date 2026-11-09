// T-546 REQ-DCIM-007 (ADR-061) — capacity arithmetic: free blocks and the largest one, states against the lines, the
// least-squares trend and the days left to a line, and how many devices of a spec a rack still takes.
import { describe, expect, it } from 'vitest';
import { TIME } from '@openmap/constants';
import {
  capacityState,
  daysUntil,
  fitsInRack,
  freeBlocks,
  largestFreeBlock,
  linearTrend,
  usedPercent,
  worstCapacityState,
} from './capacity.js';

describe('capacity arithmetic', () => {
  it('finds the free unit blocks of a rack, clipping devices past the top and ignoring overlaps', () => {
    expect(freeBlocks(10, [])).toEqual([{ start: 1, height: 10 }]);
    expect(
      freeBlocks(10, [
        { start: 1, height: 2 },
        { start: 5, height: 1 },
      ]),
    ).toEqual([
      { start: 3, height: 2 },
      { start: 6, height: 5 },
    ]);
    expect(
      freeBlocks(10, [
        { start: 9, height: 4 },
        { start: 9, height: 2 },
      ]),
    ).toEqual([{ start: 1, height: 8 }]);
    expect(freeBlocks(0, [{ start: 1, height: 1 }])).toEqual([]);
    expect(
      largestFreeBlock(42, [
        { start: 1, height: 20 },
        { start: 30, height: 2 },
      ]),
    ).toBe(11);
  });
  it('judges a used fraction against the lines and takes the worst state', () => {
    expect(usedPercent(0, 0)).toBeNull();
    expect(usedPercent(21, 42)).toBe(50);
    expect(capacityState(null, 70, 90)).toBe('unknown');
    expect(capacityState(69.9, 70, 90)).toBe('normal');
    expect(capacityState(70, 70, 90)).toBe('warning');
    expect(capacityState(95, 70, 90)).toBe('critical');
    expect(worstCapacityState(['unknown', 'normal', 'warning'])).toBe('warning');
    expect(worstCapacityState(['unknown'])).toBe('unknown');
  });
  it('fits a line through daily points and counts the days to a line, refusing to forecast from too few points', () => {
    const day = TIME.msPerDay;
    const points = Array.from({ length: 7 }, (_, i) => ({ at: i * day, value: 1000 + i * 100 }));
    const trend = linearTrend(points, 7, day);
    expect(trend?.slopePerDay).toBeCloseTo(100);
    expect(trend?.fitted).toBeCloseTo(1600);
    expect(linearTrend(points.slice(0, 3), 7, day)).toBeNull();
    expect(
      linearTrend(
        [
          { at: 0, value: 1 },
          { at: 0, value: 2 },
          { at: 0, value: 3 },
        ],
        3,
        day,
      ),
    ).toBeNull();
    expect(daysUntil(1600, 100, 2000)).toBe(4);
    expect(daysUntil(2100, 100, 2000)).toBe(0);
    expect(daysUntil(1600, 0, 2000)).toBeNull();
    expect(daysUntil(1600, -5, 2000)).toBeNull();
  });
  it('counts how many devices a rack still takes by space, power and ports', () => {
    const blocks = [
      { start: 3, height: 5 },
      { start: 20, height: 2 },
    ];
    const headroom = { largestFreeBlock: 5, freeUnits: 7, freeWatts: 1200, freePorts: 5 };
    expect(fitsInRack(blocks, headroom, { heightU: 2, watts: 300, ports: 2 })).toBe(2);
    expect(fitsInRack(blocks, headroom, { heightU: 1, watts: 0, ports: 0 })).toBe(7);
    expect(fitsInRack(blocks, headroom, { heightU: 2, watts: 500, ports: 0 })).toBe(2);
    expect(fitsInRack(blocks, headroom, { heightU: 6, watts: 0, ports: 0 })).toBe(0);
    expect(fitsInRack(blocks, { ...headroom, freeWatts: 0 }, { heightU: 1, watts: 100, ports: 0 })).toBe(0);
  });
});
