# ADR-072 — Configuration-management dynamic inventory: REST routes in each tool's own format, thin clients

Status: Accepted · Tracker: REQ-INT-011 · Contract: REST 1.2.0

## Context

Device42 feeds Ansible, Puppet, Chef and SaltStack from its CMDB, so the automation that configures a host targets
what discovery found rather than a hand-kept host list. OpenMap has the same CIs, their management addresses, sites,
tags and business services, and an authenticated REST API (ADR-049) that scripts reach with the automation client's
client-credentials token (REQ-SEC-009). Each tool reads inventory differently:

- **Ansible** runs a dynamic-inventory script (`--list` prints groups and `_meta.hostvars`) or an inventory plugin
  configured by a YAML file.
- **salt-ssh** reads a roster: a flat YAML file of minion id → host, user, port, sudo, or a roster module.
- **Puppet** runs an external node classifier (ENC) per agent: an executable given the certname that prints YAML
  with classes, parameters and an environment.
- **Chef** keeps nodes and roles on its server; `knife node|role from file` loads their JSON.

## Decision

1. **The API speaks each tool's own format; the clients stay thin.** Five routes join the REST route table under
   `/api/v1/inventory`: `ansible`, `salt`, `puppet`, `puppet/nodes/{certname}` and `chef`. The response is the tool's
   native document, so a client only authenticates, fetches and prints. The clients in `tools/inventory` use the
   Python standard library only (and Ansible's or Salt's own loaders when they run as plugins). Nothing has to be
   installed beside the tool:
   - `ansible/openmap_inventory.py`, a dynamic-inventory script;
   - `ansible/plugins/inventory/openmap.py`, an inventory plugin with `constructed` (compose, groups, keyed_groups);
   - `salt/openmap_roster.py`, which writes a roster file, and `salt/roster/openmap.py`, a live roster module;
   - `puppet/openmap_enc.py`, the ENC;
   - `chef/openmap_chef_export.py`, which writes one JSON file per node and role for knife.
2. **Authentication is the REST API's.** A bearer token in `OPENMAP_TOKEN`, or the client-credentials grant from
   `OPENMAP_TOKEN_URL`, `OPENMAP_CLIENT_ID` and `OPENMAP_CLIENT_SECRET`. Any signed-in role reads the inventory. No
   inventory-specific key or token store exists.
3. **What a node is.**
   - The CI types a tool connects to: `INVENTORY.defaultTypes` (host, VM, hypervisor, network device, load
     balancer, storage array, FC switch, cloud resource) in the discovered and managed lifecycles, unless the request
     filters otherwise.
   - The node is named by its FQDN in lower case (as Puppet certnames and Chef node names are), else by the CI name.
   - CIs that name the same node are merged into one. A host and its hypervisor share an FQDN. The CI of the earliest
     inventory type speaks for the node; the others add their ids (`openmap_merged_ids`), tags, services and any
     missing attribute.
   - The address to connect to is the management IP, then the FQDN, then the primary or guest IP. Each is read from
     identity before attributes. `ansible_host` is left out when the CI reports none.
4. **Site and business service are derived, not stored.**
   - The site is the nearest `site` CI up the `located_in` / `runs_on` / `hosted_on` chain (a VM runs on a
     hypervisor, hosted on a host, in a rack, row and room). When no chain reaches a site, the `site` attribute the
     collector observed is used.
   - A node belongs to a business service when the service's members (`part_of_service`) reach it over compute edges:
     `contains` from logical containers, `depends_on`, `runs_on`, `hosted_on`, `backed_by`. Power, cabling and
     network edges are left out on purpose. A service depends on its PDUs and switches, but an Ansible group of a
     service is the machines that run it.
   - Membership of a tenant is walked once and kept for `INVENTORY.membershipCacheMs` (60 s). On the 100k-CI estate
     the walk takes about two seconds, and a playbook run asks for the inventory on every run.
5. **Groups and variables.**
   - Ansible groups are `<facet>_<value>` (site, type, layer, tag, service, lifecycle). Each group sits under a parent
     `openmap_<facet>`, and the parents sit under `all`.
   - Group names keep letters, digits and underscores, as Ansible and Chef accept them. A value with none of those
     characters (an Arabic tag) is written as `x` followed by the hex of its bytes, so two such values never merge.
   - The facts (id, code, name, type, layer, lifecycle, site, tags, services and the requested attributes) are
     `openmap_*` variables in Ansible hostvars and Puppet parameters. Salt has them under the `openmap` grain and
     Chef under `normal.openmap`.
   - Puppet classes come from the CI's `puppetClasses` attribute, and the environment from `puppetEnvironment`, else
     the request's, else `production`.
   - Chef gets one role per site and per service, in the node's run list. The environment comes from
     `chefEnvironment`, else the request's, else `_default`.
   - Classes and environments are ordinary CI attributes, set like any other (REST `PATCH /cis/{id}/attributes`, the
     CMDB screen, an import).
6. **YAML where the tool reads YAML.**
   - The roster and ENC routes answer `application/yaml` by default and JSON with `format=json` (the SDK asks for
     JSON).
   - The route table gains `produces`, so the OpenAPI document lists both media types.
   - The API emits YAML with a small emitter of its own (block style, every string double-quoted with the characters
     YAML 1.1 readers refuse escaped), not a new dependency. Real readers check its output: Salt's renderer (PyYAML)
     and Puppet (Psych) in the tools check, T-625.
7. **Observability.**
   - Every route runs through the shared REST runner, with a `rest.<route>` span and
     `openmap_rest_requests_total` / `openmap_rest_request_duration_seconds`.
   - `openmap_inventory_exports_total{tool}` and `openmap_inventory_nodes_total{tool}` count documents and nodes.
   - The walks have their own `inventory.nodes`, `inventory.certname` and `inventory.membership` spans.

## Consequences

- REST 1.2.0, additions only. No GraphQL, event, CI or collector contract changes, and no migration.
- The console's Integrations screen shows the endpoints of the deployment, the live size of the inventory, a
  download of each document, and how to obtain a token.
- The inventory is computed per request, with no stored copy to drift. A full inventory of the 100k-CI estate
  (77,816 nodes, 54 MB of JSON) takes about 4.5 s, and a site's or a service's inventory about 2 to 5 s with the
  membership walk. Tools that run the inventory often should filter it, or use their own inventory cache (Ansible's
  `cache` options).
- `knife node from file` replaces a node's run list and normal attributes. The export suits nodes OpenMap owns. For
  nodes Chef already manages, merge the attributes instead (tools/inventory/README.md).
- Air-gapped: the routes and clients make no outbound call. The clients talk only to the deployment's API and, for
  the client-credentials grant, its Keycloak.
- The real-tools check builds a throwaway image (`tools/inventory/check/Dockerfile`: ansible-core, Salt, Puppet,
  knife with chef-zero). It is outside every compose profile and runs only when `INVENTORY_TOOLS_IMAGE` names it.
