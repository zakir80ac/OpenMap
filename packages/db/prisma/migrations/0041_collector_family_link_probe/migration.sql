-- REQ-BSM-007 (ADR-025) — the link_probe collector family joined the collector contract (0.8.0) without its database
-- enum value; jobs of the family are planned by the scheduler, so the enum carries it as the contract does.
ALTER TYPE "CollectorFamily" ADD VALUE IF NOT EXISTS 'link_probe' AFTER 'warranty';
