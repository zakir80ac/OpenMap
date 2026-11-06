-- REQ-CMDB-023 REQ-CMDB-025 (ADR-039) — the product lifecycle catalogue, shared by every tenant: one row per source,
-- product and release cycle with its release date and the end of active, security and extended support, loaded from
-- the bundled endoflife.date snapshot (packages/db/lifecycle) and refreshed by the optional, tenant-enabled sync.
CREATE TABLE "lifecycle_entries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "source" TEXT NOT NULL,
  "product" TEXT NOT NULL,
  "cycle" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "releaseDate" DATE,
  "supportEnd" DATE,
  "endOfSupport" DATE,
  "supportEnded" BOOLEAN NOT NULL DEFAULT false,
  "extendedSupportEnd" DATE,
  "latest" TEXT,
  "lts" BOOLEAN NOT NULL DEFAULT false,
  "link" TEXT,
  "fetchedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "lifecycle_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "lifecycle_entries_source_product_cycle_key" ON "lifecycle_entries"("source", "product", "cycle");
CREATE INDEX "lifecycle_entries_product_cycle_idx" ON "lifecycle_entries"("product", "cycle");
