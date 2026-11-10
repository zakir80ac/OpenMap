-- REQ-INT-017 (ADR-075) — backup and DR awareness: backup policies (Veeam jobs, Commvault plans and storage policies,
-- Rubrik SLA domains) are CIs of their own, reported by the `backup` collector family.
ALTER TYPE "CiType" ADD VALUE IF NOT EXISTS 'backup_policy' AFTER 'object_bucket';
ALTER TYPE "CollectorFamily" ADD VALUE IF NOT EXISTS 'backup' AFTER 'link_probe';
