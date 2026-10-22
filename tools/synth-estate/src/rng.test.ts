// T-026 REQ-QA-001 — seeded PRNG: reproducibility, ranges, UUID shape.
import { describe, expect, it } from 'vitest';
import { hash32, Rng } from './rng.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const DRAWS = 10_000;

describe('rng', () => {
  it('yields the same sequence for the same seed and a different one otherwise', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const c = new Rng(43);
    const seqA = Array.from({ length: 50 }, () => a.nextU32());
    const seqB = Array.from({ length: 50 }, () => b.nextU32());
    const seqC = Array.from({ length: 50 }, () => c.nextU32());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    expect(new Rng('estate').nextU32()).toBe(new Rng(hash32('estate')).nextU32());
  });

  it('keeps int and float inside their bounds', () => {
    const r = new Rng(7);
    for (let i = 0; i < DRAWS; i++) {
      const n = r.int(3, 9);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(9);
      const f = r.float(-1, 1);
      expect(f).toBeGreaterThanOrEqual(-1);
      expect(f).toBeLessThan(1);
      const u = r.next();
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
    expect(r.int(5, 2)).toBe(5);
  });

  it('produces well-formed version 4 UUIDs and MAC addresses', () => {
    const r = new Rng(99);
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = r.uuid();
      expect(id).toMatch(UUID_V4);
      seen.add(id);
      expect(r.mac([0x00, 0x50, 0x56])).toMatch(MAC);
    }
    expect(seen.size).toBe(1000);
  });

  it('forks independent but reproducible sub-streams', () => {
    const a = new Rng(1).fork('hosts');
    const b = new Rng(1).fork('hosts');
    const c = new Rng(1).fork('network');
    expect(a.nextU32()).toBe(b.nextU32());
    expect(a.nextU32()).not.toBe(c.nextU32());
  });

  it('picks by weight and shuffles deterministically', () => {
    const r = new Rng(5);
    const counts = [0, 0, 0];
    for (let i = 0; i < DRAWS; i++) {
      const w = r.weighted([1, 0, 9]);
      counts[w] = (counts[w] ?? 0) + 1;
    }
    expect(counts[1]).toBe(0);
    expect(counts[2] ?? 0).toBeGreaterThan(counts[0] ?? 0);
    expect(new Rng(3).shuffle([1, 2, 3, 4, 5])).toEqual(new Rng(3).shuffle([1, 2, 3, 4, 5]));
    expect(() => r.pick([])).toThrow();
  });
});
