-- REQ-CMDB-014 (ADR-037) — device parts and components mirrored from each CI's `components` attribute: one row per kind
-- and slot of a parent CI. A part a later sweep no longer reports keeps its row with "removedAt", so a replaced disk or a
-- moved module stays traceable; the same serial number reported by another parent closes the old row.
CREATE TABLE "ci_components" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "ciId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "slot" TEXT NOT NULL,
  "model" TEXT,
  "manufacturer" TEXT,
  "serialNumber" TEXT,
  "partNumber" TEXT,
  "capacityBytes" DOUBLE PRECISION,
  "firmware" TEXT,
  "details" JSONB NOT NULL DEFAULT '{}',
  "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
  "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
  "removedAt" TIMESTAMPTZ(3),
  CONSTRAINT "ci_components_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ci_components_ciId_kind_slot_key" ON "ci_components"("ciId", "kind", "slot");
CREATE INDEX "ci_components_tenantId_kind_model_idx" ON "ci_components"("tenantId", "kind", "model");
CREATE INDEX "ci_components_tenantId_serialNumber_idx" ON "ci_components"("tenantId", "serialNumber");
ALTER TABLE "ci_components" ADD CONSTRAINT "ci_components_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ci_components" ADD CONSTRAINT "ci_components_ciId_fkey" FOREIGN KEY ("ciId") REFERENCES "cis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
