-- REQ-CORE-013 REQ-PERF-003 — reconciliation lookup indexes. The identity tuple key is probed with
-- "= ANY(text[])" (btree, no type restriction) and globally unique identity values with jsonb
-- containment (GIN, jsonb_path_ops); without these the lookup seq-scans cis per collector result.
CREATE INDEX "cis_tenantId_identityKey_idx" ON "cis"("tenantId", "identityKey");
CREATE INDEX "cis_identity_idx" ON "cis" USING GIN ("identity" jsonb_path_ops);
