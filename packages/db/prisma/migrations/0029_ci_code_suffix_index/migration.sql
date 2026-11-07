-- REQ-CMDB-037 REQ-CORE-013 (ADR-014) — the next free code suffix is found through an index.
-- Migration 0010's cis_unique_code trigger counted a colliding code's suffixes with a regular expression over every
-- current CI of the tenant. Each colliding row of a batch insert scanned the whole tenant: on the scale-1 replay one
-- SNMP result (34,237 CIs, 29,809 of them sharing a code such as VLAN100-MGMT) ran for over fifteen minutes in one
-- INSERT. The suffix search now reads only the codes that start with "<base>-", through a byte-order (text_pattern_ops)
-- index on current rows; the regular expression still decides which of those carry a numeric suffix.
CREATE INDEX IF NOT EXISTS "cis_tenant_code_pattern" ON "cis" ("tenantId", code text_pattern_ops) WHERE "validTo" IS NULL;

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
  -- Every code that starts with "<base>-" sorts, byte-wise, at or after "<base>-" and before "<base>." ('.' follows
  -- '-'), so the range reads exactly those entries of cis_tenant_code_pattern.
  SELECT COALESCE(MAX((regexp_match(code, '-([0-9]+)$'))[1]::integer), 1) + 1 INTO next_suffix
  FROM cis
  WHERE "tenantId" = NEW."tenantId" AND "validTo" IS NULL AND id <> NEW.id
    AND code ~>=~ (base || '-') AND code ~<~ (base || '.')
    AND code ~ ('^' || base || '-[0-9]+$');
  NEW.code := base || '-' || next_suffix::text;
  RETURN NEW;
END $$;
