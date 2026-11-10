// T-611 REQ-PERF-005 (ADR-071) — the SLO catalogue: one indicator per id with a unique alert, objectives taken from the
// budgets (the GraphQL p95 objective is the screen interaction budget, the backup age the backup freshness window), the
// expressions windowed as asked, and the committed Prometheus rule file identical to what the catalogue renders.
import { readFileSync } from 'node:fs';
import { BACKUP, PERF_BUDGETS, PLATFORM_HEALTH, TIME } from '@openmap/constants';
import { describe, expect, it } from 'vitest';
import { ALERT_RULES_HEADER, PLATFORM_SLIS, PLATFORM_SLI_IDS, promWindow, renderAlertRules } from './slo.js';
import { ALERT_RULES_FILE } from './slo-rules.js';

describe('platform SLO catalogue', () => {
  it('defines every indicator once, each with its own alert', () => {
    expect(PLATFORM_SLIS.map((s) => s.id)).toEqual([...PLATFORM_SLI_IDS]);
    expect(new Set(PLATFORM_SLIS.map((s) => s.alert.name)).size).toBe(PLATFORM_SLIS.length);
  });

  it('takes its objectives from the budgets', () => {
    const byId = new Map(PLATFORM_SLIS.map((s) => [s.id, s]));
    expect(byId.get('graphql_p95_seconds')?.objective).toBe(PERF_BUDGETS.screenInteractionP95Ms / TIME.msPerSecond);
    expect(byId.get('backup_age_seconds')?.objective).toBe((BACKUP.staleHours * TIME.msPerHour) / TIME.msPerSecond);
    expect(byId.get('graphql_error_ratio')?.objective).toBe(PLATFORM_HEALTH.errorRatioMax);
    expect(byId.get('outbox_oldest_pending_seconds')?.objective).toBe(PLATFORM_HEALTH.outboxAgeMaxSeconds);
    expect(byId.get('targets_down')?.objective).toBe(0);
  });

  it('windows rate expressions as asked', () => {
    const p95 = PLATFORM_SLIS.find((s) => s.id === 'graphql_p95_seconds');
    expect(p95?.expr(promWindow(60))).toBe(
      'histogram_quantile(0.95, sum by (le) (rate(openmap_graphql_duration_seconds_bucket[60m])))',
    );
    // A window-free gauge reads the same whatever the window.
    const age = PLATFORM_SLIS.find((s) => s.id === 'outbox_oldest_pending_seconds');
    expect(age?.expr('5m')).toBe(age?.expr('1440m'));
  });

  it('renders the committed rule file exactly', () => {
    const rendered = renderAlertRules(ALERT_RULES_HEADER);
    // A checkout may convert line endings; the content is what Prometheus reads.
    expect(readFileSync(ALERT_RULES_FILE, 'utf8').replace(/\r\n/gu, '\n')).toBe(rendered);
    expect(rendered).toContain('  - name: "' + PLATFORM_HEALTH.ruleGroup + '"');
    for (const s of PLATFORM_SLIS) expect(rendered).toContain(PLATFORM_HEALTH.sliLabel + ': "' + s.id + '"');
  });
});
