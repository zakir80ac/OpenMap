-- REQ-CMDB-026 REQ-CMDB-028 (ADR-035) — commercial records are CIs. An asset's support contract is the contract CI that
-- covers it; the support_contracts table nothing wrote is dropped. The owning cost centre is a cost_centre CI.
ALTER TABLE "asset_records" DROP CONSTRAINT "asset_records_supportContractId_fkey";
DROP TABLE "support_contracts";

-- The column now names a contract CI. Assets of CIs already covered in the graph take their current covered_by
-- contract, the one ending last first.
UPDATE "asset_records" SET "supportContractId" = NULL WHERE "supportContractId" IS NOT NULL;
UPDATE "asset_records" a
SET "supportContractId" = pick."contractId"
FROM (
  SELECT DISTINCT ON (r."fromCiId") r."fromCiId" AS "ciId", r."toCiId" AS "contractId"
  FROM "relationships" r
  JOIN "cis" c ON c."id" = r."toCiId" AND c."type" = 'contract'
  WHERE r."type" = 'covered_by' AND r."validTo" IS NULL
  ORDER BY r."fromCiId", c."attributes"->>'endsAt' DESC NULLS LAST
) pick
WHERE a."ciId" = pick."ciId";

UPDATE "asset_records" a SET "ownerCostCentreCiId" = NULL
WHERE "ownerCostCentreCiId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "cis" c WHERE c."id" = a."ownerCostCentreCiId");

ALTER TABLE "asset_records" ADD CONSTRAINT "asset_records_supportContractId_fkey" FOREIGN KEY ("supportContractId") REFERENCES "cis"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "asset_records" ADD CONSTRAINT "asset_records_ownerCostCentreCiId_fkey" FOREIGN KEY ("ownerCostCentreCiId") REFERENCES "cis"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "asset_records_supportContractId_idx" ON "asset_records"("supportContractId");
CREATE INDEX "asset_records_ownerCostCentreCiId_idx" ON "asset_records"("ownerCostCentreCiId");
DROP TYPE "SupportLevel";
