// T-616 REQ-PERF-005 (ADR-071) — the SLO catalogue on the compose stack's Prometheus: every indicator, in every window
// the screen offers, and every alert condition in the rule file evaluates (Prometheus parses and runs it), so a rule
// that Prometheus would reject cannot ship; and the scrape targets the rules watch are all present.
import { loadEnv } from '@openmap/config';
import { PLATFORM_HEALTH } from '@openmap/constants';
import { PLATFORM_SLIS, promWindow } from '@openmap/telemetry';
import { describe, expect, it } from 'vitest';
import { PrometheusClient } from './prometheus.client.js';

const env = loadEnv();
const prometheus = new PrometheusClient(env.PROMETHEUS_URL);

describe('SLO rules on Prometheus (integration)', () => {
  it('evaluates every indicator in every window', async () => {
    for (const minutes of PLATFORM_HEALTH.windowsMinutes)
      for (const s of PLATFORM_SLIS) await expect(prometheus.query(s.expr(promWindow(minutes))), s.id).resolves.toBeInstanceOf(Array);
  });

  it('evaluates every alert condition of the rule file', async () => {
    const w = promWindow(PLATFORM_HEALTH.windowsMinutes[0]);
    for (const s of PLATFORM_SLIS) await expect(prometheus.query(s.alert.expr(w)), s.alert.name).resolves.toBeInstanceOf(Array);
  });

  it('rejects a malformed expression with Prometheus\'s reason', async () => {
    await expect(prometheus.query('sum(')).rejects.toThrow(/bad_data/u);
  });

  it('scrapes the jobs the rules watch', async () => {
    const jobs = new Set((await prometheus.targets()).map((t) => t.labels['job']));
    for (const job of [PLATFORM_HEALTH.jobs.services, PLATFORM_HEALTH.jobs.clickhouse, PLATFORM_HEALTH.jobs.collector]) expect(jobs.has(job), job).toBe(true);
  });
});
