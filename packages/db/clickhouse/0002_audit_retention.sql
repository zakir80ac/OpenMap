-- REQ-SEC-005 — audit log retention. The ClickHouse copy of the audit log is the analytics and retention tier;
-- rows older than {audit_retention_days} days (tenantSettingsSchema.auditRetentionDays default) are expired by
-- TTL. The Postgres audit_logs table stays append-only and is never pruned by this migration.
ALTER TABLE {database}.audit_log MODIFY TTL toDateTime(at) + INTERVAL {audit_retention_days} DAY;
