-- REQ-CMDB-033 REQ-CMDB-036 (ADR-032) — import jobs: one row per spreadsheet or CMDB export imported, with the rows
-- read, queued and refused, the refusal reasons, the mapping and the run id its observations carry.
CREATE TABLE "import_jobs" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "filename" TEXT NOT NULL,
  "format" TEXT NOT NULL,
  "rows" INTEGER NOT NULL,
  "accepted" INTEGER NOT NULL,
  "rejected" INTEGER NOT NULL,
  "rejectedRows" JSONB NOT NULL,
  "mapping" JSONB NOT NULL,
  "byType" JSONB NOT NULL,
  "runId" UUID NOT NULL,
  "submittedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "import_jobs_tenantId_createdAt_idx" ON "import_jobs"("tenantId", "createdAt" DESC);
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
