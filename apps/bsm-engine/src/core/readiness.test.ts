// T-479 REQ-BSM-007 (ADR-025) — link health from probe samples and the readiness rules: down when unreachable,
// degraded by loss or by latency above the committed figure, unknown when stale or never probed; a critical site needs
// two healthy paths (a dual-path circuit counts twice); a DR site must be reachable from a primary over healthy links,
// through an intermediate site if need be; a replication link must be healthy.
import { describe, expect, it } from 'vitest';
import { READINESS } from '@openmap/constants';
import { evaluateReadiness, linkHealth, type LinkSnapshot, type SiteSnapshot } from './readiness.js';
import type { Health } from './propagate.js';

const NOW = Date.parse('2026-11-08T00:10:00.000Z');
const MIN = 60_000;
const at = (value: number, ago = 0) => ({ value, at: NOW - ago });
const link = (ciId: string, from: string, to: string, over: Partial<LinkSnapshot> = {}): LinkSnapshot => ({
  ciId, name: ciId, fromSite: from, toSite: to, replication: false, diversePaths: 1, slaLatencyMs: null, probed: true,
  reachable: at(1), latencyMs: at(20), lossPercent: at(0), ...over,
});
const site = (code: string, over: Partial<SiteSnapshot> = {}): SiteSnapshot => ({ ciId: 'ci-' + code, code, name: code, drRole: 'none', criticality: null, ...over });

describe('linkHealth', () => {
  it('reads the latest probe', () => {
    expect(linkHealth(link('l', 'A', 'B'), NOW, MIN)).toBe('healthy');
    expect(linkHealth(link('l', 'A', 'B', { reachable: at(0), latencyMs: null, lossPercent: at(100) }), NOW, MIN)).toBe('down');
    expect(linkHealth(link('l', 'A', 'B', { lossPercent: at(READINESS.degradedLossPercent) }), NOW, MIN)).toBe('degraded');
    expect(linkHealth(link('l', 'A', 'B', { latencyMs: at(READINESS.degradedLatencyMs) }), NOW, MIN)).toBe('degraded');
    // The provider's commitment replaces the default threshold.
    expect(linkHealth(link('l', 'A', 'B', { latencyMs: at(60), slaLatencyMs: 50 }), NOW, MIN)).toBe('degraded');
    expect(linkHealth(link('l', 'A', 'B', { latencyMs: at(200), slaLatencyMs: 250 }), NOW, MIN)).toBe('healthy');
  });
  it('is unknown when never probed or stale', () => {
    expect(linkHealth(link('l', 'A', 'B', { probed: false }), NOW, MIN)).toBe('unknown');
    expect(linkHealth(link('l', 'A', 'B', { reachable: null }), NOW, MIN)).toBe('unknown');
    expect(linkHealth(link('l', 'A', 'B', { reachable: at(1, (READINESS.staleAfterProbes + 1) * MIN) }), NOW, MIN)).toBe('unknown');
  });
});

describe('evaluateReadiness', () => {
  const sites = [site('RYD', { drRole: 'primary', criticality: 1 }), site('HQ'), site('JED', { drRole: 'dr' })];
  const health = (entries: Array<[string, Health]>) => new Map(entries);

  it('passes when the critical site has two healthy paths and the DR site is reachable through HQ', () => {
    const links = [link('ryd-hq', 'RYD', 'HQ'), link('hq-jed', 'HQ', 'JED'), link('ryd-jed', 'RYD', 'JED', { replication: true })];
    const h = health([['ryd-hq', 'healthy'], ['hq-jed', 'healthy'], ['ryd-jed', 'healthy']]);
    expect(evaluateReadiness(sites, links, h)).toEqual([]);
  });

  it('breaches every rule when the replication link and the HQ leg fail', () => {
    const links = [link('ryd-hq', 'RYD', 'HQ'), link('hq-jed', 'HQ', 'JED'), link('ryd-jed', 'RYD', 'JED', { replication: true })];
    const h = health([['ryd-hq', 'healthy'], ['hq-jed', 'down'], ['ryd-jed', 'degraded']]);
    expect(evaluateReadiness(sites, links, h).map((b) => [b.rule, b.subjectCiId])).toEqual([
      ['diverse_paths', 'ci-RYD'],
      ['dr_reachable', 'ci-JED'],
      ['replication_healthy', 'ryd-jed'],
    ]);
  });

  it('counts a dual-path circuit twice and reports a missing primary', () => {
    const links = [link('ryd-hq', 'RYD', 'HQ', { diversePaths: 2 })];
    expect(evaluateReadiness([site('RYD', { criticality: 1 }), site('JED', { drRole: 'dr' })], links, health([['ryd-hq', 'healthy']])).map((b) => [b.rule, b.detail])).toEqual([
      ['dr_reachable', 'No primary site is declared, so JED cannot be reached from one.'],
    ]);
  });
});
