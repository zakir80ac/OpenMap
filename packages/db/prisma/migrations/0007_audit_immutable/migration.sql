-- REQ-SEC-005 — the audit log is append-only: no row may be updated or deleted through SQL, whatever the role of
-- the connection. Retention is served from ClickHouse (audit_log, partitioned by month), where the same events are
-- also written by the outbox dispatcher; the Postgres rows are the authoritative, immutable record.
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_no_update ON "audit_logs";
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
