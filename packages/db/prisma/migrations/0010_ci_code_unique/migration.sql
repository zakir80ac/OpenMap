-- REQ-CMDB-037 (ADR-014) — short codes unique per tenant among current CI rows.
-- 1. Existing duplicates are renumbered in validFrom order: the first keeps the code, later ones get -2, -3, ...;
--    the loop repeats until no current duplicate remains (a renumbered code can itself collide with an older one).
-- 2. A BEFORE trigger gives a new or renamed row the next free numeric suffix when its code is taken, so the
--    reconciler's single-statement batch inserts stay unique (row triggers see rows inserted earlier by the same
--    statement). 3. A partial unique index guarantees the invariant.
DO $$
DECLARE renamed integer;
BEGIN
  LOOP
    WITH ranked AS (
      SELECT id, code, row_number() OVER (PARTITION BY "tenantId", code ORDER BY "validFrom", id) AS rn
      FROM cis WHERE "validTo" IS NULL AND code IS NOT NULL
    )
    UPDATE cis AS c SET code = r.code || '-' || r.rn::text, "updatedAt" = now()
    FROM ranked r WHERE c.id = r.id AND r.rn > 1;
    GET DIAGNOSTICS renamed = ROW_COUNT;
    EXIT WHEN renamed = 0;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION cis_unique_code() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  base text;
  next_suffix integer;
BEGIN
  IF NEW.code IS NULL OR NEW."validTo" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cis WHERE "tenantId" = NEW."tenantId" AND code = NEW.code AND "validTo" IS NULL AND id <> NEW.id) THEN
    RETURN NEW;
  END IF;
  -- SRV-ESX-01 and SRV-ESX-01-2 share one counter: strip a trailing numeric suffix before counting.
  base := regexp_replace(NEW.code, '-[0-9]+$', '');
  SELECT COALESCE(MAX((regexp_match(code, '-([0-9]+)$'))[1]::integer), 1) + 1 INTO next_suffix
  FROM cis
  WHERE "tenantId" = NEW."tenantId" AND "validTo" IS NULL AND id <> NEW.id AND code ~ ('^' || base || '-[0-9]+$');
  NEW.code := base || '-' || next_suffix::text;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS cis_unique_code ON "cis";
CREATE TRIGGER cis_unique_code BEFORE INSERT OR UPDATE OF code ON "cis"
  FOR EACH ROW EXECUTE FUNCTION cis_unique_code();

CREATE UNIQUE INDEX IF NOT EXISTS "cis_tenant_code_current" ON "cis" ("tenantId", code) WHERE "validTo" IS NULL;
