// REQ-PERF-005 (ADR-071) — writes the Prometheus SLO rule file from the catalogue in slo.ts:
//   pnpm --filter @openmap/telemetry build && pnpm --filter @openmap/telemetry slo:rules
// Prometheus loads it through rule_files in deploy/compose/prometheus/prometheus.yml (restart or reload to pick it up).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALERT_RULES_HEADER, renderAlertRules } from './slo.js';

/** The committed rule file, relative to this module (src/ or dist/ sit at the same depth). */
export const ALERT_RULES_FILE = fileURLToPath(
  new URL('../../../deploy/compose/prometheus/rules/openmap-slo.rules.yml', import.meta.url),
);

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(dirname(ALERT_RULES_FILE), { recursive: true });
  writeFileSync(ALERT_RULES_FILE, renderAlertRules(ALERT_RULES_HEADER));
  console.log('wrote ' + ALERT_RULES_FILE);
}
