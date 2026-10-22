# Memgraph schema and triggers (REQ-CORE-010)

Versioned Cypher for the OpenMap dependency graph. Files are named `NNNN_name.cypher` and
applied in lexical order by `pnpm --filter @openmap/db migrate:memgraph`
(`src/migrate-memgraph.ts`) over Bolt (`MEMGRAPH_URL`, `MEMGRAPH_USER`, `MEMGRAPH_PASSWORD` from
`loadEnv()`). Applied versions are `(:SchemaMigration {version, appliedAt})` nodes; a file is
never applied twice, and a statement that reports "already exists" is treated as applied.

## Model

Every CI is one node with two labels: the common `:Ci` and its type in PascalCase derived from
`CI_TYPES` (`host` → `:Host`, `k8s_cluster` → `:K8sCluster`, `business_service` →
`:BusinessService`). A CI that a user reclassifies loses the old type label and gains the new one.

Node properties mirror the Postgres `cis` row the reconciler wrote: `id`, `tenantId`, `type`,
`identityKey`, `name`, `displayName`, `layer`, `lifecycle`, `validFrom`, `validTo` (null while
current). Attributes stay in Postgres and ClickHouse; the graph answers structure questions only.

Every `RELATIONSHIP_TYPES` member is an edge type in upper case (`depends_on` → `DEPENDS_ON`,
`part_of_service` → `PART_OF_SERVICE`). Direction is from → to exactly as the contract names it.
Edge properties: `id`, `tenantId`, `validFrom`, `validTo`, `confidence`.

Retired CIs and relationships are removed from the graph (Postgres and ClickHouse keep them), so a
traversal never has to filter on `validTo`. Time-travel structure questions run against
`ci_history` and `relationship_history` in ClickHouse.

## Constraints and indexes

- `c.id IS UNIQUE` on `:Ci`; existence of `tenantId` and `type`.
- Property indexes on `:Ci(id)`, `(tenantId)`, `(layer)`, `(lifecycle)`, `(identityKey)` and the
  composite `(tenantId, type, identityKey)` used by reconciliation lookups.
- A label index per CI type and an edge-type index per relationship type so a traversal that
  names its edge types never scans.
- `:BusinessService(impactedBy)` for ranking services by blast radius.

## Impact query shape

A failed component `$id`; `$depth` bounds the walk (ImpactScenario.options.maxDepth, 0 means the
engine substitutes its own limit). Edges point from the dependant to the dependency, so impact
flows against the arrows:

```cypher
MATCH (c:Ci {id: $id})<-[:DEPENDS_ON|RUNS_ON|POWERED_BY|HOSTED_ON*1..$depth]-(x)-[:PART_OF_SERVICE]->(s:BusinessService)
WHERE c.tenantId = $tenantId
RETURN DISTINCT s.id AS serviceId, s.name AS name, min(length(shortestPath((c)<-[*]-(x)))) AS hops
ORDER BY hops;
```

Power and rack scenarios expand first (`MATCH (r:Rack {id: $rackId})<-[:LOCATED_IN]-(c)`), then
run the same shape with the expanded set via `WHERE c.id IN $ids`.

## Triggers

Three triggers maintain `BusinessService.impactedBy`, the number of distinct CIs whose failure
reaches the service through a `DEPENDS_ON | RUNS_ON | HOSTED_ON | POWERED_BY` chain of at most
`{impact_closure_depth}` hops ending in a `PART_OF_SERVICE` edge. The console shows it as the
service's blast radius without running a traversal per row.

| Trigger                                         | Fires on                 | Scope recomputed |
| ----------------------------------------------- | ------------------------ | ---------------- |
| `business_service_impacted_by_on_edge_create`   | `ON --> CREATE AFTER COMMIT` | Services reachable from either end of each new impact edge |
| `business_service_impacted_by_on_edge_delete`   | `ON --> DELETE AFTER COMMIT` | Every service of the tenant that owned the deleted edge (deleted edges keep their properties but not their endpoints) |
| `business_service_impacted_by_on_service_create` | `ON () CREATE AFTER COMMIT` | Sets `impactedBy = 0` on a new service |

Memgraph syntax: `CREATE TRIGGER <name> ON --> CREATE AFTER COMMIT EXECUTE <query>`; the
predefined variables are `createdEdges`, `deletedEdges`, `createdVertices`.

`{impact_closure_depth}` is substituted by the runner from `IMPACT_CLOSURE_DEPTH` in
`src/parameters.ts`, because a Cypher range bound must be a literal.

## Adding a version

1. Create `memgraph/NNNN_<name>.cypher` with the next number and the `// REQ-...` header.
2. One statement per `;`; no `;` inside a trigger body.
3. `src/files.test.ts` checks ordering, that every CI type has a label index and every
   relationship type an edge index, and that the trigger syntax is present.
