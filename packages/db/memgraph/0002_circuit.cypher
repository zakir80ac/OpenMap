// REQ-DCIM-001 (ADR-056) — carrier circuits are CIs of their own; their label index, as 0001_schema gives every CI
// type. Applied after 0001 on existing graphs and on new ones alike.
CREATE INDEX ON :Circuit;
