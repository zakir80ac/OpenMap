// REQ-IPAM-005 (ADR-064) — named firewall policy objects (address and service groups, nftables sets) are CIs of their
// own; their label index, as 0001_schema gives every CI type. Applied after 0002 on existing graphs and on new ones alike.
CREATE INDEX ON :FirewallObject;
