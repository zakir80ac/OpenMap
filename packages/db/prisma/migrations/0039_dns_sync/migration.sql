-- REQ-IPAM-003 (ADR-055) — two-way DNS sync: the zones kept in sync (server, TSIG key, credential, site) and the record
-- changes requested in OpenMap with their state (pending, sent, applied, failed).

-- CreateTable
CREATE TABLE "dns_zone_syncs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "zone" TEXT NOT NULL,
    "server" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "tsigKeyName" TEXT,
    "tsigAlgorithm" TEXT,
    "credentialRef" TEXT,
    "siteId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastPullAt" TIMESTAMPTZ(3),
    "lastPushAt" TIMESTAMPTZ(3),
    "lastJobId" UUID,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "dns_zone_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dns_changes" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "zone" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "recordType" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "ttl" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "jobId" UUID,
    "error" TEXT,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMPTZ(3),

    CONSTRAINT "dns_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dns_zone_syncs_tenantId_zone_key" ON "dns_zone_syncs"("tenantId", "zone");

-- CreateIndex
CREATE INDEX "dns_changes_tenantId_zone_state_idx" ON "dns_changes"("tenantId", "zone", "state");

-- CreateIndex
CREATE INDEX "dns_changes_jobId_idx" ON "dns_changes"("jobId");

-- AddForeignKey
ALTER TABLE "dns_zone_syncs" ADD CONSTRAINT "dns_zone_syncs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dns_changes" ADD CONSTRAINT "dns_changes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
