-- REQ-CMDB-015 — tenant-defined custom fields: the definitions per tenant and the values on every CI. Values default to
-- an empty object so every existing CI reads as "no values yet"; the reconciler's statements name their columns and
-- never write this one, so discovery never overwrites what a person entered. The GIN index serves the CMDB filter.
CREATE TYPE "CustomFieldType" AS ENUM ('text', 'number', 'date', 'boolean', 'select');

CREATE TABLE "custom_field_definitions" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "labelEn" TEXT NOT NULL,
  "labelAr" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "type" "CustomFieldType" NOT NULL,
  "options" TEXT[],
  "appliesTo" "CiType"[],
  "required" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "custom_field_definitions_tenantId_key_key" ON "custom_field_definitions"("tenantId", "key");
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cis" ADD COLUMN "customFields" JSONB NOT NULL DEFAULT '{}';
CREATE INDEX "cis_customFields_idx" ON "cis" USING GIN ("customFields" jsonb_path_ops);
