// REQ-CMDB-026 (ADR-035) — an asset's support contract is the contract CI that covers its CI in the graph. Whoever
// creates or retires a `covered_by` relationship (the reconciler for a sweep or an import, the API for a person)
// calls this for the CIs it touched: an asset keeps its contract while that contract still covers it, otherwise takes
// the covering contract that ends last, or none. One statement for the batch.
import { Prisma } from '@prisma/client';

/** The transaction client of either Prisma flavour: only `$executeRaw` is needed. */
export interface RawExecutor {
  $executeRaw(query: Prisma.Sql): Promise<number>;
}

export async function refreshCoveringContracts(tx: RawExecutor, ciIds: readonly string[]): Promise<number> {
  const ids = [...new Set(ciIds)];
  if (ids.length === 0) return 0;
  return tx.$executeRaw(Prisma.sql`
    WITH covering AS (
      SELECT r."fromCiId" AS ci_id, r."toCiId" AS contract_id, c."attributes"->>'endsAt' AS ends_at
      FROM "relationships" r
      JOIN "cis" c ON c."id" = r."toCiId" AND c."type" = 'contract' AND c."validTo" IS NULL
      WHERE r."fromCiId" = ANY(${ids}::uuid[]) AND r."type" = 'covered_by' AND r."validTo" IS NULL
    ),
    best AS (
      SELECT DISTINCT ON (ci_id) ci_id, contract_id FROM covering ORDER BY ci_id, ends_at DESC NULLS LAST, contract_id
    )
    UPDATE "asset_records" a
    SET "supportContractId" = CASE
          WHEN EXISTS (SELECT 1 FROM covering k WHERE k.ci_id = a."ciId" AND k.contract_id = a."supportContractId")
            THEN a."supportContractId"
          ELSE (SELECT b.contract_id FROM best b WHERE b.ci_id = a."ciId")
        END,
        "updatedAt" = now()
    WHERE a."ciId" = ANY(${ids}::uuid[])
      AND a."supportContractId" IS DISTINCT FROM CASE
          WHEN EXISTS (SELECT 1 FROM covering k WHERE k.ci_id = a."ciId" AND k.contract_id = a."supportContractId")
            THEN a."supportContractId"
          ELSE (SELECT b.contract_id FROM best b WHERE b.ci_id = a."ciId")
        END`);
}
