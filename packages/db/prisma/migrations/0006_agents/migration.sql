-- REQ-DISC-004 — host agents: enrolled through a Discovery Node with a one-time token, reporting their own inventory.
CREATE TABLE "agents" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "nodeId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "status" "NodeEnrolmentStatus" NOT NULL,
    "enrolTokenDigest" CHAR(64),
    "enrolledAt" TIMESTAMPTZ(3),
    "certificateSerial" TEXT,
    "certificateFingerprint" CHAR(64),
    "certificateExpiresAt" TIMESTAMPTZ(3),
    "version" TEXT,
    "lastReportAt" TIMESTAMPTZ(3),
    "jobId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agents_tenantId_agentId_key" ON "agents"("tenantId", "agentId");
CREATE INDEX "agents_nodeId_status_idx" ON "agents"("nodeId", "status");

ALTER TABLE "agents" ADD CONSTRAINT "agents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agents" ADD CONSTRAINT "agents_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "discovery_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
