-- REQ-DCIM-001 (ADR-056) — carrier circuits are CIs of their own (provider, circuit id, kind, bandwidth, status) with
-- their A and Z terminations on ports and patch panel positions.
ALTER TYPE "CiType" ADD VALUE IF NOT EXISTS 'circuit' AFTER 'site_link';
