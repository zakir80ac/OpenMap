-- REQ-CMDB-037 REQ-CORE-013 (ADR-014) — the next free code suffix comes from a per-base counter.
-- Migration 0029 found a colliding code's suffixes through an index, but still read every earlier suffix of the same
-- base: the n-th CI named RED-HAT-ENTERPRISE-LINUX read n-1 index entries, so one SSH result of the scale-1 replay
-- (31,894 CIs, 3,358 of them on one base) outlived its two-minute transaction. ci_code_counters keeps the last
-- suffix handed out per (tenant, base). The first collision of a base seeds it from the codes already stored (one
-- range read through cis_tenant_code_pattern); every later one takes the next number from the counter row, and a
-- number some other write already took (a CI renamed by hand to VLAN100-MGMT-7) is skipped.
CREATE TABLE "ci_code_counters" (
  "tenantId" UUID NOT NULL,
  "base" TEXT NOT NULL,
  "last" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ci_code_counters_pkey" PRIMARY KEY ("tenantId", "base")
);

ALTER TABLE "ci_code_counters" ADD CONSTRAINT "ci_code_counters_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION cis_unique_code() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  code_base text;
  next_suffix integer;
  candidate text;
BEGIN
  IF NEW.code IS NULL OR NEW."validTo" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cis WHERE "tenantId" = NEW."tenantId" AND code = NEW.code AND "validTo" IS NULL AND id <> NEW.id) THEN
    RETURN NEW;
  END IF;
  -- SRV-ESX-01 and SRV-ESX-01-2 share one counter: strip a trailing numeric suffix before counting.
  code_base := regexp_replace(NEW.code, '-[0-9]+$', '');
  LOOP
    UPDATE ci_code_counters SET last = last + 1, "updatedAt" = now()
    WHERE "tenantId" = NEW."tenantId" AND ci_code_counters.base = code_base
    RETURNING last INTO next_suffix;
    IF NOT FOUND THEN
      -- First collision of this base: continue after the highest suffix stored. Every code that starts with "<base>-"
      -- sorts, byte-wise, at or after "<base>-" and before "<base>." ('.' follows '-').
      SELECT COALESCE(MAX((regexp_match(code, '-([0-9]+)$'))[1]::integer), 1) + 1 INTO next_suffix
      FROM cis
      WHERE "tenantId" = NEW."tenantId" AND "validTo" IS NULL AND id <> NEW.id
        AND code ~>=~ (code_base || '-') AND code ~<~ (code_base || '.')
        AND code ~ ('^' || code_base || '-[0-9]+$');
      INSERT INTO ci_code_counters ("tenantId", base, last) VALUES (NEW."tenantId", code_base, next_suffix)
      ON CONFLICT ("tenantId", base) DO UPDATE SET last = ci_code_counters.last + 1, "updatedAt" = now()
      RETURNING last INTO next_suffix;
    END IF;
    candidate := code_base || '-' || next_suffix::text;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM cis WHERE "tenantId" = NEW."tenantId" AND code = candidate AND "validTo" IS NULL AND id <> NEW.id);
  END LOOP;
  NEW.code := candidate;
  RETURN NEW;
END $$;
