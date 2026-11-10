-- REQ-IPAM-007 (ADR-069) — the network circuit register on inter-site links: the carrier contract an outage is raised
-- under (siteLinkSchema.carrierContractRef), the latency the carrier commits to, and the physical route the link takes,
-- which the path_diversity readiness rule compares between links joining the same sites. The setup record keeps them;
-- the rules read the same attributes on the site_link CI.
ALTER TABLE "site_links" ADD COLUMN "carrierContractRef" TEXT,
ADD COLUMN "slaLatencyMs" INTEGER,
ADD COLUMN "pathRef" TEXT;
