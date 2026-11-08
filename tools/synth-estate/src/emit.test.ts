// T-493 REQ-UI-026 REQ-CMDB-038 — a site link's traffic sample follows its committed bandwidth and utilisation, and the
// RNG stream is the same as when the value is drawn, so every other CI's sample keeps its value.
import { describe, expect, it } from 'vitest';
import type { EstateCi } from './estate.js';
import { samplesFor } from './emit.js';
import { Rng } from './rng.js';

const TS = '2026-10-01T00:00:00.000Z';

function ci(type: EstateCi['type'], attributes: EstateCi['attributes']): EstateCi {
  return { idx: 0, slot: 0, type, identity: { circuitId: 'STC-DARK-TEST' }, name: 'test', attributes, tags: [], externalIds: [], siteCode: 'RYD' };
}

describe('headline samples', () => {
  it('derives a site link throughput from bandwidth and utilisation', () => {
    const [sample] = samplesFor(ci('site_link', { bandwidthMbps: 10_000, utilisationPercent: 24 }), TS, new Rng('t'));
    expect(sample).toMatchObject({ metric: 'net.device.throughput_gbps', value: 2.4, unit: 'Gbps' });
  });

  it('draws a link without both figures, and keeps the RNG stream either way', () => {
    const derived = new Rng('stream');
    const drawn = new Rng('stream');
    samplesFor(ci('site_link', { bandwidthMbps: 10_000, utilisationPercent: 24 }), TS, derived);
    const [fallback] = samplesFor(ci('site_link', { bandwidthMbps: 10_000 }), TS, drawn);
    expect(fallback?.value).toBeGreaterThan(0);
    expect(derived.float(0, 1)).toBe(drawn.float(0, 1));
  });
});
