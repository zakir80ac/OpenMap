-- REQ-SEC-001 REQ-CORE-009 — the bootstrap tenant. A fresh deployment has no organization yet, but the first
-- administrator signs in through the Keycloak realm with the tenant claim `default` (the realm import attaches it to
-- the seeded admin) and the API resolves that claim to a tenant row. This row is what the onboarding wizard renames
-- and grows into the real organization; nothing else is scoped to it until discovery or onboarding writes data.
-- Fixed ids keep every deployment (air-gapped included) identical and make the statement safe to re-run.
INSERT INTO "organizations" ("id", "name", "industry", "timeZone", "defaultLocale", "regulatoryScope", "airGapped", "updatedAt")
VALUES ('00000000-0000-4000-8000-000000000001', 'OpenMap', 'unspecified', 'UTC', 'en', '{}', false, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "tenants" ("id", "organizationId", "name", "slug", "active", "updatedAt")
VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'Default', 'default', true, CURRENT_TIMESTAMP)
ON CONFLICT ("organizationId", "slug") DO NOTHING;

-- Mirrors TENANT_SETTINGS_DEFAULTS in @openmap/config (locale en, UTC, 60-minute sweeps, 365 days of history,
-- stale after 7 days, assistant on, outbound integrations off until a tenant enables them).
INSERT INTO "tenant_settings" ("tenantId", "locale", "timeZone", "discoveryIntervalMinutes", "historyRetentionDays", "staleAfterDays", "assistantEnabled", "outboundIntegrationsEnabled", "updatedAt")
SELECT t."id", 'en', 'UTC', 60, 365, 7, true, false, CURRENT_TIMESTAMP
FROM "tenants" t
WHERE t."slug" = 'default' AND t."organizationId" = '00000000-0000-4000-8000-000000000001'
ON CONFLICT ("tenantId") DO NOTHING;
