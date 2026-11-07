-- REQ-CORE-013 (ADR-045) — `*Ref` resolution in reconciliation.
-- 1. "refTokens": every normalised spelling under which a `*Ref` may name the CI (identity values, `serial:<serial>`,
--    `name@version`, the name, FQDN and address attributes). The reconciler computes them; a write by anyone else that
--    changes the identity, name or attributes empties them (trigger below), and the pending pass computes them again.
-- 2. "refKey": the identity tuple with each ref replaced by the id of the CI it names (`listening_service|ref=@<id>|tcp|443`).
-- 3. "refsPending": a ref of the CI names no single known CI yet; "refsCheckedAt" orders the pending pass round robin.
ALTER TABLE "cis"
  ADD COLUMN "refTokens" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "refKey" TEXT,
  ADD COLUMN "refsPending" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "refsCheckedAt" TIMESTAMPTZ(3);

CREATE INDEX "cis_refTokens_idx" ON "cis" USING GIN ("refTokens");
CREATE INDEX "cis_tenantId_refKey_idx" ON "cis" ("tenantId", "refKey");
CREATE INDEX "cis_refs_pending_idx" ON "cis" ("tenantId", "refsCheckedAt") WHERE "refsPending" AND "validTo" IS NULL;
CREATE INDEX "cis_ref_tokens_missing_idx" ON "cis" ("tenantId", type) WHERE cardinality("refTokens") = 0 AND "validTo" IS NULL;

-- Every current CI is resolved once by the pending pass, which also folds the copies that observers naming one CI
-- differently created before this migration; a CI without refs simply leaves the pending set.
UPDATE "cis" SET "refsPending" = true WHERE "validTo" IS NULL;

-- The reconciler marks its own transactions (set_config('openmap.ref_tokens', 'reconciler', true)) because it writes
-- tokens, ref keys and the pending flag itself. A CI any other writer inserts (the onboarding wizard's sites and racks,
-- the commercial register's contracts) or whose identity it changes is left pending, and one whose identity, name or
-- attributes it changes loses its tokens, so the pending pass computes both again.
CREATE OR REPLACE FUNCTION cis_ref_writes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('openmap.ref_tokens', true), '') = 'reconciler' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW."refTokens" := ARRAY[]::TEXT[];
    NEW."refKey" := NULL;
    NEW."refsPending" := NEW."validTo" IS NULL;
    RETURN NEW;
  END IF;
  IF NEW.identity IS DISTINCT FROM OLD.identity OR NEW.name IS DISTINCT FROM OLD.name OR NEW.attributes IS DISTINCT FROM OLD.attributes THEN
    NEW."refTokens" := ARRAY[]::TEXT[];
  END IF;
  IF NEW.identity IS DISTINCT FROM OLD.identity THEN
    NEW."refKey" := NULL;
    NEW."refsPending" := NEW."validTo" IS NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cis_ref_writes BEFORE INSERT OR UPDATE ON "cis"
FOR EACH ROW EXECUTE FUNCTION cis_ref_writes();
