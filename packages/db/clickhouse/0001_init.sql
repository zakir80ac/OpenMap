-- REQ-CORE-010 — ClickHouse analytics and history store, version 0001.
--
-- Substitution parameters (replaced by src/migrate-clickhouse.ts before each statement runs):
--   {database}               CLICKHOUSE_DB from @openmap/config
--   {history_retention_days} tenantSettingsSchema.historyRetentionDays default
--                            (TENANT_SETTINGS_DEFAULTS in @openmap/config); the metrics TTL.
-- Statements end with ';' on its own line boundary; comment lines are stripped before splitting.
-- JSON documents (identity, attributes, envelopes) are stored as String so Superset and every
-- ClickHouse version in the compose stack read them with JSONExtract* functions.

-- ---------------------------------------------------------------------------------------------
-- Time travel: every CI and relationship version ever reconciled
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS {database}.ci_history
(
    tenant_id           UUID,
    ci_id               UUID,
    type                LowCardinality(String),
    layer               LowCardinality(String),
    lifecycle           LowCardinality(String),
    name                String,
    display_name        String,
    identity_key        String,
    identity            String,
    attributes          String,
    tags                Array(String),
    user_label          String,
    source_collector_id LowCardinality(String),
    source_node_id      LowCardinality(String),
    source_run_id       UUID,
    source_confidence   Float32,
    observed_at         DateTime64(3, 'UTC'),
    valid_from          DateTime64(3, 'UTC'),
    valid_to            Nullable(DateTime64(3, 'UTC')),
    checksum            FixedString(64),
    recorded_at         DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(recorded_at)
PARTITION BY toYYYYMM(valid_from)
ORDER BY (tenant_id, ci_id, valid_from);

CREATE TABLE IF NOT EXISTS {database}.relationship_history
(
    tenant_id           UUID,
    relationship_id     UUID,
    type                LowCardinality(String),
    from_ci_id          UUID,
    to_ci_id            UUID,
    attributes          String,
    source_collector_id LowCardinality(String),
    source_node_id      LowCardinality(String),
    source_run_id       UUID,
    source_confidence   Float32,
    observed_at         DateTime64(3, 'UTC'),
    valid_from          DateTime64(3, 'UTC'),
    valid_to            Nullable(DateTime64(3, 'UTC')),
    recorded_at         DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(recorded_at)
PARTITION BY toYYYYMM(valid_from)
ORDER BY (tenant_id, relationship_id, valid_from);

-- ---------------------------------------------------------------------------------------------
-- Metrics: host, VM, power, temperature and IPAM samples. labels carries dimensions such as
-- rack_id, pdu_id, cidr, interface. See README.md for the metric name conventions.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS {database}.metrics
(
    tenant_id     UUID,
    ci_id         UUID,
    metric        LowCardinality(String),
    ts            DateTime64(3, 'UTC'),
    value         Float64,
    unit          LowCardinality(String),
    labels        Map(LowCardinality(String), String),
    source_run_id UUID
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (tenant_id, ci_id, metric, ts)
TTL toDateTime(ts) + INTERVAL {history_retention_days} DAY;

-- ---------------------------------------------------------------------------------------------
-- Audit, events, discovery runs, service health, integration deliveries
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS {database}.audit_log
(
    tenant_id    UUID,
    id           UUID,
    actor        String,
    action       LowCardinality(String),
    subject_type LowCardinality(String),
    subject_id   String,
    details      String,
    traceparent  String,
    at           DateTime64(3, 'UTC')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(at)
ORDER BY (tenant_id, at, id);

CREATE TABLE IF NOT EXISTS {database}.events
(
    sequence    UInt64,
    event_id    UUID,
    tenant_id   UUID,
    type        LowCardinality(String),
    source      LowCardinality(String),
    subject     String,
    time        DateTime64(3, 'UTC'),
    traceparent String,
    data        String,
    envelope    String
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(time)
ORDER BY (tenant_id, type, time, sequence);

CREATE TABLE IF NOT EXISTS {database}.discovery_runs
(
    tenant_id             UUID,
    run_id                UUID,
    job_id                UUID,
    collector_id          LowCardinality(String),
    node_id               LowCardinality(String),
    status                LowCardinality(String),
    started_at            DateTime64(3, 'UTC'),
    finished_at           DateTime64(3, 'UTC'),
    targets_attempted     UInt32,
    targets_reached       UInt32,
    cis_emitted           UInt32,
    relationships_emitted UInt32,
    duration_ms           UInt32,
    error_count           UInt32,
    errors                String
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(started_at)
ORDER BY (tenant_id, started_at, run_id);

CREATE TABLE IF NOT EXISTS {database}.service_health_history
(
    tenant_id                    UUID,
    service_ci_id                UUID,
    health                       LowCardinality(String),
    score                        Float32,
    cause_ci_id                  Nullable(UUID),
    sla_budget_remaining_minutes Nullable(Float64),
    ts                           DateTime64(3, 'UTC')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (tenant_id, service_ci_id, ts);

CREATE TABLE IF NOT EXISTS {database}.integration_deliveries
(
    tenant_id      UUID,
    id             UUID,
    integration_id UUID,
    direction      LowCardinality(String),
    event_id       Nullable(UUID),
    remote_id      String,
    state          LowCardinality(String),
    attempts       UInt16,
    request_digest FixedString(64),
    response_code  Nullable(Int32),
    error          String,
    created_at     DateTime64(3, 'UTC'),
    completed_at   Nullable(DateTime64(3, 'UTC'))
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, integration_id, created_at, id);

-- ---------------------------------------------------------------------------------------------
-- Materialized views. Targets are AggregatingMergeTree; read with uniqMerge/avgMerge/etc.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS {database}.layer_counts_daily
(
    tenant_id UUID,
    day       Date,
    layer     LowCardinality(String),
    type      LowCardinality(String),
    cis       AggregateFunction(uniq, UUID),
    versions  AggregateFunction(count)
)
ENGINE = AggregatingMergeTree
ORDER BY (tenant_id, day, layer, type);

CREATE MATERIALIZED VIEW IF NOT EXISTS {database}.layer_counts_daily_mv
TO {database}.layer_counts_daily
AS SELECT
    tenant_id,
    toDate(valid_from) AS day,
    layer,
    type,
    uniqState(ci_id)   AS cis,
    countState()       AS versions
FROM {database}.ci_history
GROUP BY tenant_id, day, layer, type;

CREATE TABLE IF NOT EXISTS {database}.subnet_utilisation_daily
(
    tenant_id       UUID,
    day             Date,
    subnet_ci_id    UUID,
    cidr            String,
    utilisation_avg AggregateFunction(avg, Float64),
    utilisation_max AggregateFunction(max, Float64)
)
ENGINE = AggregatingMergeTree
ORDER BY (tenant_id, day, subnet_ci_id, cidr);

CREATE MATERIALIZED VIEW IF NOT EXISTS {database}.subnet_utilisation_daily_mv
TO {database}.subnet_utilisation_daily
AS SELECT
    tenant_id,
    toDate(ts)        AS day,
    ci_id             AS subnet_ci_id,
    labels['cidr']    AS cidr,
    avgState(value)   AS utilisation_avg,
    maxState(value)   AS utilisation_max
FROM {database}.metrics
WHERE metric = 'ipam.subnet.utilisation_percent'
GROUP BY tenant_id, day, subnet_ci_id, cidr;

CREATE TABLE IF NOT EXISTS {database}.power_by_rack_hourly
(
    tenant_id  UUID,
    hour       DateTime('UTC'),
    rack_ci_id UUID,
    watts_avg  AggregateFunction(avg, Float64),
    watts_max  AggregateFunction(max, Float64),
    samples    AggregateFunction(count)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (tenant_id, hour, rack_ci_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS {database}.power_by_rack_hourly_mv
TO {database}.power_by_rack_hourly
AS SELECT
    tenant_id,
    toStartOfHour(toDateTime(ts, 'UTC'))  AS hour,
    toUUIDOrZero(labels['rack_id'])       AS rack_ci_id,
    avgState(value)                       AS watts_avg,
    maxState(value)                       AS watts_max,
    countState()                          AS samples
FROM {database}.metrics
WHERE metric = 'dcim.power.watts' AND labels['rack_id'] != ''
GROUP BY tenant_id, hour, rack_ci_id;
