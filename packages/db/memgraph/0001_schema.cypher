// REQ-CORE-010 — Memgraph dependency graph schema, version 0001.
//
// Applied in order by src/migrate-memgraph.ts over Bolt; applied versions are recorded as
// (:SchemaMigration {version}) nodes. Statements end with ';' at a line end; '//' comment lines
// are stripped before splitting. Substitution parameters:
//   {impact_closure_depth}  IMPACT_CLOSURE_DEPTH from src/parameters.ts: how many dependency
//                           hops the impactedBy triggers walk.
//
// Model: every CI is a node labelled :Ci plus its type in PascalCase (:Ci:Host, :Ci:Vm,
// :Ci:BusinessService ...). Node properties: id, tenantId, type, identityKey, name, displayName,
// layer, lifecycle, validFrom, validTo. Every relationship type from RELATIONSHIP_TYPES is an
// edge type in upper case (depends_on -> DEPENDS_ON) with properties id, tenantId, validFrom,
// validTo, confidence. See README.md for the impact query shape.

// ---------------------------------------------------------------------------------------------
// Constraints and indexes on the common :Ci label
// ---------------------------------------------------------------------------------------------

CREATE CONSTRAINT ON (c:Ci) ASSERT c.id IS UNIQUE;
CREATE CONSTRAINT ON (c:Ci) ASSERT EXISTS (c.tenantId);
CREATE CONSTRAINT ON (c:Ci) ASSERT EXISTS (c.type);
CREATE INDEX ON :Ci;
CREATE INDEX ON :Ci(id);
CREATE INDEX ON :Ci(tenantId);
CREATE INDEX ON :Ci(layer);
CREATE INDEX ON :Ci(lifecycle);
CREATE INDEX ON :Ci(identityKey);
CREATE INDEX ON :Ci(tenantId, type, identityKey);
CREATE INDEX ON :BusinessService(impactedBy);
CREATE INDEX ON :SchemaMigration(version);

// ---------------------------------------------------------------------------------------------
// One label per CI type (CI_TYPES in PascalCase)
// ---------------------------------------------------------------------------------------------

CREATE INDEX ON :Host;
CREATE INDEX ON :Chassis;
CREATE INDEX ON :Blade;
CREATE INDEX ON :Bmc;
CREATE INDEX ON :Hypervisor;
CREATE INDEX ON :VmCluster;
CREATE INDEX ON :Vm;
CREATE INDEX ON :OperatingSystem;
CREATE INDEX ON :Container;
CREATE INDEX ON :K8sCluster;
CREATE INDEX ON :K8sNamespace;
CREATE INDEX ON :K8sWorkload;
CREATE INDEX ON :K8sService;
CREATE INDEX ON :ContainerRegistry;
CREATE INDEX ON :NetworkDevice;
CREATE INDEX ON :Interface;
CREATE INDEX ON :Port;
CREATE INDEX ON :Vlan;
CREATE INDEX ON :Vrf;
CREATE INDEX ON :IpAddress;
CREATE INDEX ON :Subnet;
CREATE INDEX ON :DnsZone;
CREATE INDEX ON :DnsRecord;
CREATE INDEX ON :DhcpScope;
CREATE INDEX ON :DhcpLease;
CREATE INDEX ON :LoadBalancer;
CREATE INDEX ON :FirewallRule;
CREATE INDEX ON :SiteLink;
CREATE INDEX ON :StorageArray;
CREATE INDEX ON :Lun;
CREATE INDEX ON :FcSwitch;
CREATE INDEX ON :FcFabric;
CREATE INDEX ON :FcZone;
CREATE INDEX ON :NasShare;
CREATE INDEX ON :ObjectBucket;
CREATE INDEX ON :Database;
CREATE INDEX ON :DatabaseCluster;
CREATE INDEX ON :Certificate;
CREATE INDEX ON :Application;
CREATE INDEX ON :ApplicationComponent;
CREATE INDEX ON :ListeningService;
CREATE INDEX ON :BusinessService;
CREATE INDEX ON :Software;
CREATE INDEX ON :SoftwareInstance;
CREATE INDEX ON :Licence;
CREATE INDEX ON :Vulnerability;
CREATE INDEX ON :Site;
CREATE INDEX ON :Building;
CREATE INDEX ON :Room;
CREATE INDEX ON :Row;
CREATE INDEX ON :Rack;
CREATE INDEX ON :Pdu;
CREATE INDEX ON :PowerFeed;
CREATE INDEX ON :PowerCircuit;
CREATE INDEX ON :Ups;
CREATE INDEX ON :CoolingUnit;
CREATE INDEX ON :Cable;
CREATE INDEX ON :PatchPanel;
CREATE INDEX ON :CloudAccount;
CREATE INDEX ON :CloudResource;
CREATE INDEX ON :SaasApplication;
CREATE INDEX ON :SaasTenant;
CREATE INDEX ON :UserAccount;
CREATE INDEX ON :ServiceAccount;
CREATE INDEX ON :Vendor;
CREATE INDEX ON :Contract;
CREATE INDEX ON :CostCentre;
CREATE INDEX ON :Unknown;

// ---------------------------------------------------------------------------------------------
// Edge-type indexes (RELATIONSHIP_TYPES upper-cased)
// ---------------------------------------------------------------------------------------------

CREATE EDGE INDEX ON :DEPENDS_ON;
CREATE EDGE INDEX ON :RUNS_ON;
CREATE EDGE INDEX ON :HOSTED_ON;
CREATE EDGE INDEX ON :CONTAINS;
CREATE EDGE INDEX ON :MEMBER_OF;
CREATE EDGE INDEX ON :CONNECTED_TO;
CREATE EDGE INDEX ON :CABLED_TO;
CREATE EDGE INDEX ON :LOCATED_IN;
CREATE EDGE INDEX ON :POWERED_BY;
CREATE EDGE INDEX ON :COOLED_BY;
CREATE EDGE INDEX ON :USES_IP;
CREATE EDGE INDEX ON :IN_SUBNET;
CREATE EDGE INDEX ON :IN_VLAN;
CREATE EDGE INDEX ON :RESOLVES_TO;
CREATE EDGE INDEX ON :LEASED_TO;
CREATE EDGE INDEX ON :INSTALLED_ON;
CREATE EDGE INDEX ON :LICENSED_BY;
CREATE EDGE INDEX ON :AFFECTED_BY;
CREATE EDGE INDEX ON :PART_OF_SERVICE;
CREATE EDGE INDEX ON :COMMUNICATES_WITH;
CREATE EDGE INDEX ON :MOUNTED_ON;
CREATE EDGE INDEX ON :BACKED_BY;
CREATE EDGE INDEX ON :OWNS;
CREATE EDGE INDEX ON :MANAGES;
CREATE EDGE INDEX ON :BILLED_TO;
CREATE EDGE INDEX ON :SECURED_BY;
CREATE EDGE INDEX ON :COVERED_BY;
CREATE EDGE INDEX ON :SUPPORTED_BY;
CREATE EDGE INDEX ON :ASSIGNED_TO;
CREATE EDGE INDEX ON :SPARE_FOR;
CREATE EDGE INDEX ON :ZONED_WITH;
CREATE EDGE INDEX ON :PRESENTED_TO;
CREATE EDGE INDEX ON :REPLICATES_TO;

// ---------------------------------------------------------------------------------------------
// Triggers: keep BusinessService.impactedBy = number of distinct CIs whose failure reaches the
// service through DEPENDS_ON / RUNS_ON / HOSTED_ON / POWERED_BY chains ending in a
// PART_OF_SERVICE edge. Recomputed for the services an edge change can touch.
// ---------------------------------------------------------------------------------------------

CREATE TRIGGER business_service_impacted_by_on_edge_create
ON --> CREATE AFTER COMMIT EXECUTE
UNWIND createdEdges AS e
WITH e
WHERE type(e) IN ['PART_OF_SERVICE', 'DEPENDS_ON', 'RUNS_ON', 'HOSTED_ON', 'POWERED_BY']
UNWIND [startNode(e), endNode(e)] AS n
WITH DISTINCT n
MATCH (n)<-[:DEPENDS_ON|RUNS_ON|HOSTED_ON|POWERED_BY*0..{impact_closure_depth}]-(x:Ci)-[:PART_OF_SERVICE]->(s:BusinessService)
WITH DISTINCT s
MATCH (c:Ci)<-[:DEPENDS_ON|RUNS_ON|HOSTED_ON|POWERED_BY*0..{impact_closure_depth}]-(y:Ci)-[:PART_OF_SERVICE]->(s)
WITH s, count(DISTINCT c) AS impacted
SET s.impactedBy = impacted, s.impactedByUpdatedAt = localDateTime();

CREATE TRIGGER business_service_impacted_by_on_edge_delete
ON --> DELETE AFTER COMMIT EXECUTE
UNWIND deletedEdges AS e
WITH e
WHERE type(e) IN ['PART_OF_SERVICE', 'DEPENDS_ON', 'RUNS_ON', 'HOSTED_ON', 'POWERED_BY']
WITH DISTINCT e.tenantId AS tenantId
MATCH (s:BusinessService {tenantId: tenantId})
OPTIONAL MATCH (c:Ci)<-[:DEPENDS_ON|RUNS_ON|HOSTED_ON|POWERED_BY*0..{impact_closure_depth}]-(y:Ci)-[:PART_OF_SERVICE]->(s)
WITH s, count(DISTINCT c) AS impacted
SET s.impactedBy = impacted, s.impactedByUpdatedAt = localDateTime();

CREATE TRIGGER business_service_impacted_by_on_service_create
ON () CREATE AFTER COMMIT EXECUTE
UNWIND createdVertices AS v
WITH v
WHERE v:BusinessService AND v.impactedBy IS NULL
SET v.impactedBy = 0, v.impactedByUpdatedAt = localDateTime();
