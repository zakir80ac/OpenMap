-- REQ-CORE-020 — outbox claims safe for concurrent dispatchers: a dispatcher leases the rows it takes (FOR UPDATE
-- SKIP LOCKED, then claimedBy and claimedUntil), so two loops or two reconciler replicas never deliver the same row,
-- and a dispatcher that dies releases its rows when the lease runs out.

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "claimedBy" TEXT,
ADD COLUMN     "claimedUntil" TIMESTAMPTZ(3);
