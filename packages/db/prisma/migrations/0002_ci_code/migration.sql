-- REQ-CMDB-037 — CI short codes (ciCode) shown on cards and used in search.
-- AlterTable
ALTER TABLE "cis" ADD COLUMN     "code" VARCHAR(64);

-- CreateIndex
CREATE INDEX "cis_tenantId_code_idx" ON "cis"("tenantId", "code");

