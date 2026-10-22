-- REQ-CORE-013 — relationship observations waiting for their endpoints to be discovered.
-- CreateTable
CREATE TABLE "pending_relationships" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "type" "RelationshipType" NOT NULL,
    "fromRef" JSONB NOT NULL,
    "toRef" JSONB NOT NULL,
    "attributes" JSONB NOT NULL,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "sourceCollectorId" TEXT NOT NULL,
    "sourceNodeId" TEXT NOT NULL,
    "sourceRunId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_relationships_tenantId_createdAt_idx" ON "pending_relationships"("tenantId", "createdAt");

