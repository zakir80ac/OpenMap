-- REQ-SEC-005 — append-only still, with one exception: when a tenant is removed, its audit rows go with it
-- (the ON DELETE CASCADE on audit_logs.tenantId). During that cascade the tenant row is already gone, which is
-- how the trigger tells offboarding apart from an attempt to erase history inside a live tenant.
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "tenants" WHERE "id" = OLD."tenantId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;
