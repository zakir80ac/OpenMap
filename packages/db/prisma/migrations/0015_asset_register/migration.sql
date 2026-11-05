-- REQ-CMDB-039 REQ-CMDB-040 (ADR-023) — the asset register covers every owned CI, not only a plan's BOM units.
-- A row records where it came from (source), the register layer and CI type it lists under, and support cover
-- entered on the row itself; manufacturer and model become nullable because a software instance or a cloud
-- resource has neither. One asset per CI is enforced. Existing rows (all from plans) take the layer of the BOM line
-- that produced them. Finally the register is backfilled from the CMDB: one deployed, discovery-sourced row per
-- current CI of an owned type, with the warranty, purchase and subscription dates the collectors already observed
-- (the same mapping the reconciler applies to new CIs, assetFieldsFromCi in packages/contracts).
CREATE TYPE "AssetSource" AS ENUM ('plan', 'discovery', 'manual');

ALTER TABLE "asset_records"
  ALTER COLUMN "manufacturer" DROP NOT NULL,
  ALTER COLUMN "model" DROP NOT NULL,
  ADD COLUMN "ciType" "CiType",
  ADD COLUMN "layer" "CiLayer",
  ADD COLUMN "source" "AssetSource" NOT NULL DEFAULT 'plan',
  ADD COLUMN "support" JSONB;

UPDATE "asset_records" a SET "layer" = COALESCE(
  (SELECT b."layer" FROM "bom_lines" b
    WHERE b."planId" = a."planId"
      AND b."manufacturer" IS NOT DISTINCT FROM a."manufacturer"
      AND b."model" IS NOT DISTINCT FROM a."model"
    ORDER BY b."position" LIMIT 1),
  (SELECT b."layer" FROM "bom_lines" b WHERE b."planId" = a."planId" ORDER BY b."position" LIMIT 1),
  'hardware');
ALTER TABLE "asset_records" ALTER COLUMN "layer" SET NOT NULL;
ALTER TABLE "asset_records" ALTER COLUMN "source" DROP DEFAULT;

CREATE UNIQUE INDEX "asset_records_tenantId_ciId_key" ON "asset_records"("tenantId", "ciId");
CREATE INDEX "asset_records_tenantId_layer_idx" ON "asset_records"("tenantId", "layer");
CREATE INDEX "asset_records_tenantId_source_idx" ON "asset_records"("tenantId", "source");

-- Backfill. The preferred tag is the organisation's own (attributes.assetTag), then the CI code; a tag already taken
-- falls back to the code in a second pass, then to the CI id, so every owned CI ends with exactly one row.
CREATE TEMP TABLE owned_cis AS
SELECT c."id", c."tenantId", c."type", c."layer", c."code", c."attributes" AS a
FROM "cis" c
WHERE c."validTo" IS NULL AND c."type" IN ('host', 'chassis', 'blade', 'bmc', 'hypervisor', 'vm_cluster', 'vm', 'operating_system', 'k8s_cluster', 'network_device', 'load_balancer', 'storage_array', 'fc_switch', 'database', 'database_cluster', 'certificate', 'application', 'software', 'software_instance', 'licence', 'rack', 'pdu', 'ups', 'cooling_unit', 'patch_panel', 'cloud_account', 'cloud_resource', 'saas_application', 'saas_tenant')
  AND NOT EXISTS (SELECT 1 FROM "asset_records" r WHERE r."tenantId" = c."tenantId" AND r."ciId" = c."id");

CREATE OR REPLACE FUNCTION pg_temp.asset_warranty(a JSONB) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN a->>'warrantyEnd' IS NULL OR COALESCE(a->>'warrantyProvider', a->>'manufacturer', a->>'vendor') IS NULL THEN NULL
    ELSE jsonb_build_object(
      'provider', COALESCE(a->>'warrantyProvider', a->>'manufacturer', a->>'vendor'),
      'level', a->'warrantyLevel',
      'startsAt', a->'purchaseDate',
      'endsAt', a->>'warrantyEnd',
      'source', 'vendor_api',
      'verifiedAt', NULL) END
$$;
CREATE OR REPLACE FUNCTION pg_temp.asset_support(t TEXT, a JSONB) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN t IN ('licence', 'saas_application', 'saas_tenant', 'certificate') AND a->>'expiresAt' IS NOT NULL AND a->>'vendor' IS NOT NULL
    THEN jsonb_build_object('provider', a->>'vendor', 'contractNumber', a->'poNumber', 'level', a->'licenceType', 'endsAt', a->>'expiresAt', 'source', 'vendor_api', 'verifiedAt', NULL)
    ELSE NULL END
$$;

INSERT INTO "asset_records" ("id", "tenantId", "ciId", "ciType", "layer", "source", "assetTag", "serialNumber", "manufacturer", "model", "partNumber",
  "stage", "stageChangedAt", "purchasedAt", "depreciationMethod", "usefulLifeMonths", "residualValueAmount", "residualValueCurrency",
  "warranty", "support", "tags", "customFields", "createdAt", "updatedAt")
SELECT gen_random_uuid(), o."tenantId", o."id", o."type", o."layer", 'discovery',
  COALESCE(NULLIF(o.a->>'assetTag', ''), o."code", o."id"::text),
  NULLIF(o.a->>'serialNumber', ''),
  COALESCE(NULLIF(o.a->>'manufacturer', ''), NULLIF(o.a->>'vendor', '')),
  COALESCE(NULLIF(o.a->>'model', ''), NULLIF(o.a->>'product', ''), NULLIF(o.a->>'software', ''), NULLIF(o.a->>'name', ''), NULLIF(o.a->>'sku', ''), NULLIF(o.a->>'resourceType', '')),
  COALESCE(NULLIF(o.a->>'partNumber', ''), NULLIF(o.a->>'sku', '')),
  'deployed', now(),
  CASE WHEN o.a->>'purchaseDate' ~ '^\d{4}-\d{2}-\d{2}$' THEN (o.a->>'purchaseDate')::date ELSE NULL END,
  'none', 1, 0, COALESCE(NULLIF(o.a->>'currency', ''), 'XXX'),
  pg_temp.asset_warranty(o.a), pg_temp.asset_support(o."type"::text, o.a), ARRAY[]::text[], '{}'::jsonb, now(), now()
FROM owned_cis o
ON CONFLICT DO NOTHING;

INSERT INTO "asset_records" ("id", "tenantId", "ciId", "ciType", "layer", "source", "assetTag", "serialNumber", "manufacturer", "model", "partNumber",
  "stage", "stageChangedAt", "purchasedAt", "depreciationMethod", "usefulLifeMonths", "residualValueAmount", "residualValueCurrency",
  "warranty", "support", "tags", "customFields", "createdAt", "updatedAt")
SELECT gen_random_uuid(), o."tenantId", o."id", o."type", o."layer", 'discovery',
  COALESCE(o."code", o."id"::text),
  NULLIF(o.a->>'serialNumber', ''),
  COALESCE(NULLIF(o.a->>'manufacturer', ''), NULLIF(o.a->>'vendor', '')),
  COALESCE(NULLIF(o.a->>'model', ''), NULLIF(o.a->>'product', ''), NULLIF(o.a->>'software', ''), NULLIF(o.a->>'name', ''), NULLIF(o.a->>'sku', ''), NULLIF(o.a->>'resourceType', '')),
  COALESCE(NULLIF(o.a->>'partNumber', ''), NULLIF(o.a->>'sku', '')),
  'deployed', now(),
  CASE WHEN o.a->>'purchaseDate' ~ '^\d{4}-\d{2}-\d{2}$' THEN (o.a->>'purchaseDate')::date ELSE NULL END,
  'none', 1, 0, COALESCE(NULLIF(o.a->>'currency', ''), 'XXX'),
  pg_temp.asset_warranty(o.a), pg_temp.asset_support(o."type"::text, o.a), ARRAY[]::text[], '{}'::jsonb, now(), now()
FROM owned_cis o
WHERE NOT EXISTS (SELECT 1 FROM "asset_records" r WHERE r."tenantId" = o."tenantId" AND r."ciId" = o."id")
ON CONFLICT DO NOTHING;

INSERT INTO "asset_records" ("id", "tenantId", "ciId", "ciType", "layer", "source", "assetTag", "serialNumber", "manufacturer", "model", "partNumber",
  "stage", "stageChangedAt", "purchasedAt", "depreciationMethod", "usefulLifeMonths", "residualValueAmount", "residualValueCurrency",
  "warranty", "support", "tags", "customFields", "createdAt", "updatedAt")
SELECT gen_random_uuid(), o."tenantId", o."id", o."type", o."layer", 'discovery', o."id"::text,
  NULLIF(o.a->>'serialNumber', ''),
  COALESCE(NULLIF(o.a->>'manufacturer', ''), NULLIF(o.a->>'vendor', '')),
  COALESCE(NULLIF(o.a->>'model', ''), NULLIF(o.a->>'product', ''), NULLIF(o.a->>'software', ''), NULLIF(o.a->>'name', ''), NULLIF(o.a->>'sku', ''), NULLIF(o.a->>'resourceType', '')),
  COALESCE(NULLIF(o.a->>'partNumber', ''), NULLIF(o.a->>'sku', '')),
  'deployed', now(),
  CASE WHEN o.a->>'purchaseDate' ~ '^\d{4}-\d{2}-\d{2}$' THEN (o.a->>'purchaseDate')::date ELSE NULL END,
  'none', 1, 0, COALESCE(NULLIF(o.a->>'currency', ''), 'XXX'),
  pg_temp.asset_warranty(o.a), pg_temp.asset_support(o."type"::text, o.a), ARRAY[]::text[], '{}'::jsonb, now(), now()
FROM owned_cis o
WHERE NOT EXISTS (SELECT 1 FROM "asset_records" r WHERE r."tenantId" = o."tenantId" AND r."ciId" = o."id");

DROP TABLE owned_cis;
