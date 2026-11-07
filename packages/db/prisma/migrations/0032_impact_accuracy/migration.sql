-- REQ-BSM-004 (ADR-047) — impact prediction accuracy. A resolved incident with a root cause is compared with a
-- simulation of that root cause (impact_validations, created in 0001). Replays of incidents are scenarios of origin
-- 'incident', kept out of the saved list; every service the incident hit that no modelled path reached becomes a
-- relationship suggestion (root cause part_of_service missed service) for a person to accept or dismiss.

-- CreateEnum
CREATE TYPE "ScenarioOrigin" AS ENUM ('user', 'incident');

-- CreateEnum
CREATE TYPE "SuggestionState" AS ENUM ('open', 'accepted', 'dismissed');

-- AlterTable
ALTER TABLE "impact_scenarios" ADD COLUMN     "origin" "ScenarioOrigin" NOT NULL DEFAULT 'user';

-- CreateTable
CREATE TABLE "relationship_suggestions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "type" "RelationshipType" NOT NULL,
    "fromCiId" UUID NOT NULL,
    "toCiId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "lastIncidentId" UUID,
    "state" "SuggestionState" NOT NULL DEFAULT 'open',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "relationshipId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "relationship_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "relationship_suggestions_tenantId_state_occurrences_idx" ON "relationship_suggestions"("tenantId", "state", "occurrences");

-- CreateIndex
CREATE UNIQUE INDEX "relationship_suggestions_tenantId_fromCiId_toCiId_type_key" ON "relationship_suggestions"("tenantId", "fromCiId", "toCiId", "type");

-- CreateIndex
CREATE INDEX "impact_scenarios_tenantId_origin_createdAt_idx" ON "impact_scenarios"("tenantId", "origin", "createdAt");

-- CreateIndex
CREATE INDEX "impact_validations_tenantId_validatedAt_idx" ON "impact_validations"("tenantId", "validatedAt");

-- CreateIndex
-- One current validation per incident: validating again replaces it.
CREATE UNIQUE INDEX "impact_validations_incidentId_key" ON "impact_validations"("incidentId");

-- AddForeignKey
ALTER TABLE "relationship_suggestions" ADD CONSTRAINT "relationship_suggestions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationship_suggestions" ADD CONSTRAINT "relationship_suggestions_fromCiId_fkey" FOREIGN KEY ("fromCiId") REFERENCES "cis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationship_suggestions" ADD CONSTRAINT "relationship_suggestions_toCiId_fkey" FOREIGN KEY ("toCiId") REFERENCES "cis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

