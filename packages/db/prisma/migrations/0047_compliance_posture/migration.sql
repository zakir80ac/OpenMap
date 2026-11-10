-- REQ-SEC-012 (ADR-070) — compliance posture: each evaluation of a tenant with its per-framework summary, and every
-- check's decision on every subject with the facts that decided it (the audit evidence).

-- CreateTable
CREATE TABLE "compliance_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "catalogueVersion" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "summary" JSONB NOT NULL,

    CONSTRAINT "compliance_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_results" (
    "runId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "check" TEXT NOT NULL,
    "ciId" UUID,
    "result" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "facts" JSONB NOT NULL,
    "highRisk" BOOLEAN NOT NULL DEFAULT false,
    "seq" INTEGER NOT NULL,

    CONSTRAINT "compliance_results_pkey" PRIMARY KEY ("runId", "seq")
);

-- CreateIndex
CREATE INDEX "compliance_runs_tenantId_startedAt_idx" ON "compliance_runs"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "compliance_results_runId_check_result_idx" ON "compliance_results"("runId", "check", "result");

-- AddForeignKey
ALTER TABLE "compliance_runs" ADD CONSTRAINT "compliance_runs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_results" ADD CONSTRAINT "compliance_results_runId_fkey" FOREIGN KEY ("runId") REFERENCES "compliance_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
