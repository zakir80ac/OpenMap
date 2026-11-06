-- REQ-CMDB-020 (ADR-034) — receiving against plan lines: each planned unit knows its BOM line, and every receipt is a
-- row with its day, reference, location and the assets it took into stock.
ALTER TABLE "asset_records" ADD COLUMN "bomLineId" UUID;
ALTER TABLE "asset_records" ADD CONSTRAINT "asset_records_bomLineId_fkey" FOREIGN KEY ("bomLineId") REFERENCES "bom_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "asset_records_bomLineId_idx" ON "asset_records"("bomLineId");

-- Existing planned units carry their line in the tag createPlan gave them: <plan number>-<position + 1>-<unit>.
UPDATE "asset_records" a
SET "bomLineId" = b."id"
FROM "bom_lines" b
JOIN "infra_plans" p ON p."id" = b."planId"
WHERE a."planId" = p."id"
  AND a."source" = 'plan'
  AND a."bomLineId" IS NULL
  AND a."assetTag" LIKE p."number" || '-' || (b."position" + 1)::text || '-%';

CREATE TABLE "plan_receipts" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "planId" UUID NOT NULL,
  "bomLineId" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  "receivedOn" DATE NOT NULL,
  "receivedBy" TEXT NOT NULL,
  "reference" TEXT,
  "locationCiId" UUID,
  "assetIds" UUID[] NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "plan_receipts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "plan_receipts_tenantId_planId_createdAt_idx" ON "plan_receipts"("tenantId", "planId", "createdAt");
ALTER TABLE "plan_receipts" ADD CONSTRAINT "plan_receipts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plan_receipts" ADD CONSTRAINT "plan_receipts_planId_fkey" FOREIGN KEY ("planId") REFERENCES "infra_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plan_receipts" ADD CONSTRAINT "plan_receipts_bomLineId_fkey" FOREIGN KEY ("bomLineId") REFERENCES "bom_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
