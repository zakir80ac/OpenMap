-- REQ-BSM-007 (ADR-025) — sites and connectivity for HA / DR readiness: a site's DR role and business criticality,
-- a link's replication flag and probe target (the setup records; the rules read the same attributes on the CIs), and
-- the readiness findings: one row per rule breached by a site or link CI, open until it clears.

-- CreateEnum
CREATE TYPE "SiteDrRole" AS ENUM ('primary', 'dr', 'none');

-- AlterTable
ALTER TABLE "sites" ADD COLUMN     "criticality" INTEGER,
ADD COLUMN     "drRole" "SiteDrRole" NOT NULL DEFAULT 'none';

-- AlterTable
ALTER TABLE "site_links" ADD COLUMN     "probeTarget" TEXT,
ADD COLUMN     "replication" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "readiness_findings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "rule" TEXT NOT NULL,
    "subjectCiId" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "openedAt" TIMESTAMPTZ(3) NOT NULL,
    "clearedAt" TIMESTAMPTZ(3),
    "incidentId" UUID,

    CONSTRAINT "readiness_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "readiness_findings_tenantId_state_idx" ON "readiness_findings"("tenantId", "state");

-- CreateIndex
CREATE INDEX "readiness_findings_tenantId_rule_subjectCiId_state_idx" ON "readiness_findings"("tenantId", "rule", "subjectCiId", "state");

-- AddForeignKey
ALTER TABLE "readiness_findings" ADD CONSTRAINT "readiness_findings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- At most one open finding per tenant, rule and subject (Prisma cannot model a partial index).
CREATE UNIQUE INDEX "readiness_findings_open_key" ON "readiness_findings"("tenantId", "rule", "subjectCiId") WHERE "state" = 'open';
