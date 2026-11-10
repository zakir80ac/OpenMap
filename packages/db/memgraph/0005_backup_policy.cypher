// REQ-INT-017 (ADR-075) — backup policies are CIs of their own; their label index, as 0001_schema gives every CI type.
CREATE INDEX ON :BackupPolicy;
