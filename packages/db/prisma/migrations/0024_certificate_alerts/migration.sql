-- REQ-CMDB-032 (ADR-036) — the expiry alerts already raised: one row per certificate, expiry date and threshold, so the
-- watcher raises each alert once. A renewed certificate is a new CI (new fingerprint) and starts its own alerts.
CREATE TABLE "certificate_alerts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "ciId" UUID NOT NULL,
  "notAfter" TIMESTAMPTZ(3) NOT NULL,
  "thresholdDays" INTEGER NOT NULL,
  "daysLeft" INTEGER NOT NULL,
  "eventId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "certificate_alerts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "certificate_alerts_ciId_notAfter_thresholdDays_key" ON "certificate_alerts"("ciId", "notAfter", "thresholdDays");
CREATE INDEX "certificate_alerts_tenantId_createdAt_idx" ON "certificate_alerts"("tenantId", "createdAt");
ALTER TABLE "certificate_alerts" ADD CONSTRAINT "certificate_alerts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "certificate_alerts" ADD CONSTRAINT "certificate_alerts_ciId_fkey" FOREIGN KEY ("ciId") REFERENCES "cis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
