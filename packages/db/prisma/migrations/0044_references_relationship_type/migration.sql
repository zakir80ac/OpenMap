-- REQ-IPAM-005 (ADR-064 consequences) — a configuration record names another (a firewall rule an address or service
-- group). Not an impact edge. Firewall rules first linked their objects with depends_on, which the impact walk follows:
-- on firewalls with shared groups the undirected walk exploded; those links become references.
ALTER TYPE "RelationshipType" ADD VALUE IF NOT EXISTS 'references';
