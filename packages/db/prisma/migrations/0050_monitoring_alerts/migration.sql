-- REQ-INT-012 (ADR-073) — monitoring event ingest: one row per alert of a monitoring integration (by its source
-- fingerprint), the CI it resolved to and what it does to that CI's health while firing; and the operators' mappings
-- of alert sources the CI lookup could not place.

-- CreateTable
CREATE TABLE "monitoring_alerts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "vendor" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "effect" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "sourceUrl" TEXT,
    "targets" JSONB NOT NULL,
    "sourceKeys" TEXT[],
    "labels" JSONB NOT NULL,
    "ciId" UUID,
    "resolution" TEXT,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3),
    "receivedCount" INTEGER NOT NULL DEFAULT 1,
    "firstReceivedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastReceivedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastEventId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "monitoring_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitoring_source_mappings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "ciId" UUID NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "monitoring_source_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "monitoring_alerts_tenantId_status_lastReceivedAt_idx" ON "monitoring_alerts"("tenantId", "status", "lastReceivedAt");

-- CreateIndex
CREATE INDEX "monitoring_alerts_tenantId_ciId_status_idx" ON "monitoring_alerts"("tenantId", "ciId", "status");

-- CreateIndex
CREATE INDEX "monitoring_alerts_updatedAt_idx" ON "monitoring_alerts"("updatedAt");

-- CreateIndex
CREATE INDEX "monitoring_alerts_sourceKeys_idx" ON "monitoring_alerts" USING GIN ("sourceKeys");

-- CreateIndex
CREATE UNIQUE INDEX "monitoring_alerts_integrationId_fingerprint_key" ON "monitoring_alerts"("integrationId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "monitoring_source_mappings_tenantId_sourceKey_key" ON "monitoring_source_mappings"("tenantId", "sourceKey");

-- AddForeignKey
ALTER TABLE "monitoring_alerts" ADD CONSTRAINT "monitoring_alerts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitoring_alerts" ADD CONSTRAINT "monitoring_alerts_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integration_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitoring_source_mappings" ADD CONSTRAINT "monitoring_source_mappings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
