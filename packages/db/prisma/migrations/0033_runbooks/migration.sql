-- REQ-BSM-005 (ADR-048) — runbooks: a catalogue per tenant (code unique in the tenant) that scenarios and incidents
-- attach by reference, and the record of every step run on an incident (manual done, automation triggered or failed).
-- The scenario's embedded runbook column from 0013 never held a value and is replaced by the reference.

-- CreateEnum
CREATE TYPE "RunbookStepOutcome" AS ENUM ('done', 'triggered', 'failed');

-- AlterTable
ALTER TABLE "impact_scenarios" DROP COLUMN "runbook",
ADD COLUMN     "runbookId" UUID;

-- AlterTable
ALTER TABLE "incidents" ADD COLUMN     "runbookId" UUID;

-- CreateTable
CREATE TABLE "runbooks" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "ownerTeam" TEXT NOT NULL,
    "lastReviewedAt" DATE,
    "steps" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "runbooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runbook_step_runs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "runbookId" UUID,
    "order" INTEGER NOT NULL,
    "outcome" "RunbookStepOutcome" NOT NULL,
    "actor" TEXT NOT NULL,
    "note" TEXT,
    "integrationId" UUID,
    "deliveryId" UUID,
    "remoteId" TEXT,
    "error" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "runbook_step_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "runbooks_tenantId_code_key" ON "runbooks"("tenantId", "code");

-- CreateIndex
CREATE INDEX "runbook_step_runs_incidentId_at_idx" ON "runbook_step_runs"("incidentId", "at");

-- AddForeignKey
ALTER TABLE "impact_scenarios" ADD CONSTRAINT "impact_scenarios_runbookId_fkey" FOREIGN KEY ("runbookId") REFERENCES "runbooks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runbooks" ADD CONSTRAINT "runbooks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runbook_step_runs" ADD CONSTRAINT "runbook_step_runs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runbook_step_runs" ADD CONSTRAINT "runbook_step_runs_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runbook_step_runs" ADD CONSTRAINT "runbook_step_runs_runbookId_fkey" FOREIGN KEY ("runbookId") REFERENCES "runbooks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_runbookId_fkey" FOREIGN KEY ("runbookId") REFERENCES "runbooks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

