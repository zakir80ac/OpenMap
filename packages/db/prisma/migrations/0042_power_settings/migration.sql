-- REQ-DCIM-005 (ADR-059) — a tenant's power thresholds and energy tariff.
CREATE TABLE "power_settings" (
    "tenantId" UUID NOT NULL,
    "warnPercent" DOUBLE PRECISION NOT NULL,
    "criticalPercent" DOUBLE PRECISION NOT NULL,
    "tariffPerKwh" DECIMAL(12,6),
    "currency" CHAR(3),
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "power_settings_pkey" PRIMARY KEY ("tenantId")
);

ALTER TABLE "power_settings" ADD CONSTRAINT "power_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
