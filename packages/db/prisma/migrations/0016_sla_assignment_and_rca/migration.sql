-- REQ-BSM-006 REQ-BSM-008 (ADR-024) — service level agreements a business service is held to, the assignment of one
-- SLA per service, and the incident fields of incident response: assignee, the response and resolution deadlines
-- the engine checks every tick, the breach stamps, the closing fields and the structured root cause analysis.
CREATE TYPE "SlaWindow" AS ENUM ('calendar_month', 'calendar_quarter', 'calendar_year', 'rolling_30d');

CREATE TABLE "slas" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "availabilityTargetPercent" DOUBLE PRECISION NOT NULL,
  "window" "SlaWindow" NOT NULL DEFAULT 'calendar_month',
  "responseTargets" JSONB NOT NULL DEFAULT '{}',
  "burnRateAlert" DOUBLE PRECISION NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "slas_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "slas_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "slas_tenantId_name_key" ON "slas"("tenantId", "name");

CREATE TABLE "service_sla_assignments" (
  "tenantId" UUID NOT NULL,
  "serviceCiId" UUID NOT NULL,
  "slaId" UUID NOT NULL,
  "assignedBy" TEXT NOT NULL,
  "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "service_sla_assignments_pkey" PRIMARY KEY ("tenantId", "serviceCiId"),
  CONSTRAINT "service_sla_assignments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "service_sla_assignments_slaId_fkey" FOREIGN KEY ("slaId") REFERENCES "slas"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "service_sla_assignments_slaId_idx" ON "service_sla_assignments"("slaId");

ALTER TABLE "incidents"
  ADD COLUMN "closedAt" TIMESTAMPTZ(3),
  ADD COLUMN "assignee" TEXT,
  ADD COLUMN "slaId" UUID,
  ADD COLUMN "respondBy" TIMESTAMPTZ(3),
  ADD COLUMN "resolveBy" TIMESTAMPTZ(3),
  ADD COLUMN "responseBreachedAt" TIMESTAMPTZ(3),
  ADD COLUMN "resolutionBreachedAt" TIMESTAMPTZ(3),
  ADD COLUMN "resolutionNote" TEXT,
  ADD COLUMN "rca" JSONB,
  ADD CONSTRAINT "incidents_slaId_fkey" FOREIGN KEY ("slaId") REFERENCES "slas"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "incidents_tenantId_source_state_idx" ON "incidents"("tenantId", "source", "state");
