-- REQ-IPAM-005 (ADR-064) — named firewall policy objects (address and service groups, nftables sets) that firewall
-- rules reference are CIs of their own, identified by the device and the object id.
ALTER TYPE "CiType" ADD VALUE IF NOT EXISTS 'firewall_object' AFTER 'firewall_rule';
