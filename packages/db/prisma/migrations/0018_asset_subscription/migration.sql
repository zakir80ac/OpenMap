-- REQ-CMDB-042 (ADR-027) — software, SaaS and cloud assets carry a subscription (start, end, credits remaining) in
-- place of a warranty. The column is filled once from what the collectors already observed on the CI (a licence's
-- expiry and type, a SaaS or cloud term, a credit balance) with the same mapping packages/contracts applies to new CIs
-- (subscriptionFromAttributes); nothing is invented, so a CI without a term end or a balance keeps a null that the
-- register flags as the subscription gap.
ALTER TABLE "asset_records" ADD COLUMN "subscription" JSONB;

CREATE OR REPLACE FUNCTION pg_temp.first_date(a JSONB, VARIADIC keys TEXT[]) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k TEXT; v TEXT;
BEGIN
  FOREACH k IN ARRAY keys LOOP
    v := a->>k;
    IF v IS NOT NULL AND v <> '' THEN
      IF v ~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN v; END IF;
      BEGIN RETURN to_char((v::timestamptz AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD'); EXCEPTION WHEN others THEN NULL; END;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.first_text(a JSONB, VARIADIC keys TEXT[]) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k TEXT; v TEXT;
BEGIN
  FOREACH k IN ARRAY keys LOOP
    v := a->>k;
    IF v IS NOT NULL AND v <> '' THEN RETURN v; END IF;
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.asset_subscription(a JSONB, observed TIMESTAMPTZ) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE provider TEXT; ends TEXT; remaining NUMERIC; credits JSONB; as_of TEXT;
BEGIN
  provider := pg_temp.first_text(a, 'vendor', 'provider', 'manufacturer');
  IF provider IS NULL THEN RETURN NULL; END IF;
  ends := pg_temp.first_date(a, 'subscriptionEnd', 'expiresAt', 'nextLifecycleDateTime');
  IF jsonb_typeof(a->'creditsRemaining') = 'number' AND (a->>'creditsRemaining')::numeric >= 0 THEN
    remaining := (a->>'creditsRemaining')::numeric;
    as_of := COALESCE(a->>'creditsAsOf', to_char(observed AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    credits := jsonb_build_object('remaining', remaining, 'unit', COALESCE(a->>'creditsUnit', 'credits'), 'currency', a->'creditsCurrency', 'asOf', as_of);
  END IF;
  IF ends IS NULL AND credits IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('provider', provider, 'plan', pg_temp.first_text(a, 'plan', 'licenceType', 'sku', 'edition'),
    'startsAt', pg_temp.first_date(a, 'subscriptionStart', 'activatedAt', 'purchaseDate'), 'endsAt', ends, 'credits', credits,
    'source', 'vendor_api', 'verifiedAt', NULL);
END $$;

UPDATE "asset_records" ar
SET "subscription" = pg_temp.asset_subscription(c."attributes", c."observedAt")
FROM "cis" c
WHERE c."id" = ar."ciId"
  AND ar."subscription" IS NULL
  AND c."type"::text IN ('software', 'software_instance', 'licence', 'saas_application', 'saas_tenant', 'cloud_account', 'cloud_resource');
