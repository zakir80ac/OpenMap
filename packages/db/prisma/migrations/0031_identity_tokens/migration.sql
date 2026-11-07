-- REQ-CORE-013 (ADR-045) — candidate CIs are found by identity token, one GIN probe per batch of values.
-- The reconciler looked a result's globally unique values up with jsonb containment (identity @> '{"serialNumber": …}'),
-- one term per value. Neither form held at full scale: an OR chain of 500 terms was planned as a sequential scan of cis
-- once the tenant held 550,000 CIs (6 to 38 s per chunk), and one probe per term cost a heap visit per term (1 to 5 s
-- per 500 terms in the pending pass). "identityTokens" holds every identity value of the row as a normalised
-- "key=value" string (trimmed, lower case, as packages/contracts normIdentity writes it). The lookup probes the tokens
-- of the globally unique keys with one array overlap per batch; the scope of a scoped key is still compared in memory.
-- A trigger fills the column on every insert and every identity change, whoever writes, so no writer can leave a CI
-- unfindable.
ALTER TABLE "cis" ADD COLUMN "identityTokens" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE OR REPLACE FUNCTION cis_identity_tokens() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.identity IS DISTINCT FROM OLD.identity THEN
    NEW."identityTokens" := ARRAY(
      SELECT key || '=' || lower(btrim(value)) FROM jsonb_each_text(NEW.identity) WHERE btrim(value) <> '' ORDER BY 1
    );
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cis_identity_tokens BEFORE INSERT OR UPDATE OF identity ON "cis"
FOR EACH ROW EXECUTE FUNCTION cis_identity_tokens();

-- Current rows only: the lookup reads current rows, and a retired row keeps its identity unchanged.
UPDATE "cis" SET "identityTokens" = ARRAY(
  SELECT key || '=' || lower(btrim(value)) FROM jsonb_each_text(identity) WHERE btrim(value) <> '' ORDER BY 1
) WHERE "validTo" IS NULL;

CREATE INDEX "cis_identity_tokens_idx" ON "cis" USING GIN ("identityTokens") WHERE "validTo" IS NULL;

-- The planner needs the new column's element statistics, or it estimates every overlap probe as most of the table.
ANALYZE "cis";
