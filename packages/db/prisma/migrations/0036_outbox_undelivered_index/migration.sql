-- REQ-CORE-020 (ADR-050) — the dispatcher's claim takes the oldest undelivered rows. Without these indexes it walked the
-- primary key from the first row ever written and filtered out every delivered one: 1.6 s per claim with 2.6 million
-- delivered rows. Partial indexes hold only the undelivered rows, so a claim reads just the batch it takes, whether it
-- claims every tenant's rows (the reconciler) or one tenant's (replays). Partial indexes are not expressible in the
-- Prisma schema, as with migrations 0029 and 0031.

CREATE INDEX IF NOT EXISTS "outbox_events_undelivered_idx" ON "outbox_events" ("sequence") WHERE "deliveredAt" IS NULL;
CREATE INDEX IF NOT EXISTS "outbox_events_tenant_undelivered_idx" ON "outbox_events" ("tenantId", "sequence") WHERE "deliveredAt" IS NULL;
