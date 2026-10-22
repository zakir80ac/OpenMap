# ClickHouse DDL (REQ-CORE-010)

Versioned DDL for the OpenMap analytics and history store. Files are named `NNNN_name.sql` and
applied in lexical order by `pnpm --filter @openmap/db migrate:clickhouse`
(`src/migrate-clickhouse.ts`). Applied versions are recorded in `{database}.schema_migrations`;
a file is never applied twice.

## Substitution parameters

The runner replaces these tokens in every statement before sending it:

| Token                      | Source                                                      |
| -------------------------- | ----------------------------------------------------------- |
| `{database}`               | `CLICKHOUSE_DB` from `@openmap/config` (`loadEnv()`)         |
| `{history_retention_days}` | `TENANT_SETTINGS_DEFAULTS.historyRetentionDays` (`@openmap/config`); the `metrics` TTL |
| `{audit_retention_days}`   | `TENANT_SETTINGS_DEFAULTS.auditRetentionDays` (`@openmap/config`); the `audit_log` TTL (REQ-SEC-005) |

Nothing else in a file is interpreted; no secrets ever appear in DDL. The connection
(`CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`) comes from `loadEnv()` only.

Statements are split on `;` at a line end after `--` comment lines are removed, so a comment may
contain a semicolon but a statement body must not contain `;` inside a string literal.

## Tables

| Table                      | Engine                 | Key                                         | Purpose |
| -------------------------- | ---------------------- | ------------------------------------------- | ------- |
| `ci_history`               | ReplacingMergeTree     | `(tenant_id, ci_id, valid_from)`            | Every CI version; time travel reads `valid_from <= t AND (valid_to IS NULL OR valid_to > t)` |
| `relationship_history`     | ReplacingMergeTree     | `(tenant_id, relationship_id, valid_from)`  | Every relationship version |
| `metrics`                  | MergeTree, monthly parts, TTL | `(tenant_id, ci_id, metric, ts)`     | Host, VM, power, temperature, IPAM samples |
| `audit_log`                | MergeTree              | `(tenant_id, at, id)`                       | Mirror of Postgres `audit_logs` for long retention and Superset |
| `events`                   | ReplacingMergeTree     | `(tenant_id, type, time, sequence)`         | Every outbox envelope, for analytics and replay |
| `discovery_runs`           | ReplacingMergeTree     | `(tenant_id, started_at, run_id)`           | Collector run metrics |
| `service_health_history`   | MergeTree              | `(tenant_id, service_ci_id, ts)`            | BSM health transitions |
| `integration_deliveries`   | ReplacingMergeTree     | `(tenant_id, integration_id, created_at, id)` | Integration delivery audit |

JSON payloads (`identity`, `attributes`, `user_label`, `envelope`, `data`, `errors`, `details`)
are `String` columns; query them with `JSONExtractString(attributes, 'serialNumber')` and friends.

## Metric name conventions

`metric` is dotted `<domain>.<object>.<measure>[_<unit>]`; `labels` carries dimensions.

| Metric                             | Unit    | Labels                      |
| ---------------------------------- | ------- | --------------------------- |
| `host.cpu.utilisation_percent`     | percent |                             |
| `host.memory.utilisation_percent`  | percent |                             |
| `vm.cpu.utilisation_percent`       | percent | `hypervisor_id`             |
| `dcim.power.watts`                 | W       | `rack_id`, `pdu_id`, `feed` |
| `dcim.temperature.celsius`         | C       | `rack_id`, `sensor`         |
| `ipam.subnet.utilisation_percent`  | percent | `cidr`, `vrf`               |

## Materialized views

Targets are `AggregatingMergeTree`; read them with the `-Merge` combinators.

| View                        | Target                     | Source     | Read with |
| --------------------------- | -------------------------- | ---------- | --------- |
| `layer_counts_daily_mv`     | `layer_counts_daily`       | `ci_history` | `uniqMerge(cis)`, `countMerge(versions)` grouped by `tenant_id, day, layer` |
| `subnet_utilisation_daily_mv` | `subnet_utilisation_daily` | `metrics` where `ipam.subnet.utilisation_percent` | `avgMerge(utilisation_avg)`, `maxMerge(utilisation_max)` |
| `power_by_rack_hourly_mv`   | `power_by_rack_hourly`     | `metrics` where `dcim.power.watts` and `labels['rack_id']` set | `avgMerge(watts_avg)`, `maxMerge(watts_max)`, `countMerge(samples)` |

Example:

```sql
SELECT day, layer, uniqMerge(cis) AS cis
FROM openmap.layer_counts_daily
WHERE tenant_id = {tenant:UUID}
GROUP BY day, layer
ORDER BY day;
```

## Adding a version

1. Create `clickhouse/NNNN_<name>.sql` with the next number and the `-- REQ-...` header.
2. Use `IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` so a partially applied
   file can be re-run.
3. Reference every table as `{database}.<table>`.
4. The unit tests in `src/files.test.ts` check ordering and that every token is known.
