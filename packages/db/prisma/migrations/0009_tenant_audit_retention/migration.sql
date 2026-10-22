-- REQ-SEC-005 — per-tenant audit retention for the ClickHouse copy of the audit log. The default mirrors
-- TENANT_SETTINGS_DEFAULTS.auditRetentionDays (seven years) so existing tenants keep the documented behaviour.
ALTER TABLE "tenant_settings" ADD COLUMN "auditRetentionDays" INTEGER NOT NULL DEFAULT 2555;
