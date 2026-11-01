-- REQ-CMDB-038 ADR-016 — latest sample per (tenant, CI, metric). The API reads the headline metric of every card
-- and table row from here with one IN query per page instead of scanning the time series; the view keeps the
-- table current from every insert into {database}.metrics. ReplacingMergeTree keyed on ts lets a read with
-- argMax(value, ts) ignore parts that have not merged yet.
CREATE TABLE IF NOT EXISTS {database}.metrics_latest
(
    tenant_id UUID,
    ci_id     UUID,
    metric    LowCardinality(String),
    ts        DateTime64(3, 'UTC'),
    value     Float64,
    unit      LowCardinality(String)
)
ENGINE = ReplacingMergeTree(ts)
ORDER BY (tenant_id, ci_id, metric);

CREATE MATERIALIZED VIEW IF NOT EXISTS {database}.metrics_latest_mv TO {database}.metrics_latest AS
SELECT tenant_id, ci_id, metric, ts, value, unit
FROM {database}.metrics;
