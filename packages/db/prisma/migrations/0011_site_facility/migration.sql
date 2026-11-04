-- REQ-UI-024 REQ-UI-020 (ADR-017) — facility capacity facts of a site (siteSchema.facility): design power, rack
-- count and design PUE, entered in the setup wizard and mirrored onto the site CI. Null for cloud regions.
ALTER TABLE "sites"
  ADD COLUMN "powerCapacityKw" DOUBLE PRECISION,
  ADD COLUMN "rackCount" INTEGER,
  ADD COLUMN "designPue" DOUBLE PRECISION;
