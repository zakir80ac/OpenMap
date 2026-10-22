// REQ-CORE-010 — substitution parameters for the versioned ClickHouse and Memgraph files.
// Each value is identical in every deployment or comes from @openmap/config; the files
// themselves carry no connection detail.
import type { Env } from '@openmap/config';
import { TENANT_SETTINGS_DEFAULTS } from '@openmap/config';

/**
 * Hops the Memgraph impactedBy triggers walk along DEPENDS_ON / RUNS_ON / HOSTED_ON / POWERED_BY
 * before the PART_OF_SERVICE edge. Six covers the deepest chain the layer model produces
 * (application → container → VM → hypervisor → host → PDU) with one hop to spare; a Cypher
 * range bound must be a literal, so it is substituted into the file rather than passed as a
 * query parameter.
 */
export const IMPACT_CLOSURE_DEPTH = 6;

/** Tokens the ClickHouse runner replaces; documented in clickhouse/README.md. */
export function clickhouseParameters(env: Env): Record<string, string> {
  return {
    database: env.CLICKHOUSE_DB,
    history_retention_days: String(TENANT_SETTINGS_DEFAULTS.historyRetentionDays),
    audit_retention_days: String(TENANT_SETTINGS_DEFAULTS.auditRetentionDays),
  };
}

/** Tokens the Memgraph runner replaces; documented in memgraph/README.md. */
export function memgraphParameters(): Record<string, string> {
  return { impact_closure_depth: String(IMPACT_CLOSURE_DEPTH) };
}
