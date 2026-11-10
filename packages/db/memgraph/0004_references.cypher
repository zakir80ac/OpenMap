// REQ-IPAM-005 (ADR-064 consequences) — the edge index for the `references` relationship type, as 0001_schema gives
// every relationship type; and the firewall rule → policy object links first written as DEPENDS_ON (an impact edge)
// move to it, so the impact walk no longer runs through shared address and service groups.
CREATE EDGE INDEX ON :REFERENCES;
MATCH (r:FirewallRule)-[d:DEPENDS_ON]->(o:FirewallObject) CREATE (r)-[n:REFERENCES]->(o) SET n = properties(d) DELETE d;
