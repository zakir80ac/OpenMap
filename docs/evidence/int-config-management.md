# REQ-INT-011 — configuration-management dynamic inventory: evidence (2026-11-10)

REQ-INT-011 makes the CMDB the inventory source for Ansible, SaltStack, Puppet and Chef (Device42 parity, CAPABILITY-MAP
row "Configuration management"). Decision: ADR-072. Contract: REST 1.2.0 (`docs/CONTRACTS.md`).

## What was built

- **API** (`apps/api/src/rest/inventory.controller.ts`, `apps/api/src/inventory/`): five routes of the REST route
  table. Each needs a bearer token (a person's, or the `openmap-automation` client-credentials token); any role reads.
  - `GET /api/v1/inventory/ansible`: Ansible dynamic-inventory JSON, `_meta.hostvars` plus groups.
  - `GET /api/v1/inventory/salt`: the salt-ssh flat roster, YAML (or `format=json`).
  - `GET /api/v1/inventory/puppet` and `GET /api/v1/inventory/puppet/nodes/{certname}`: Puppet ENC documents, YAML
    (or JSON).
  - `GET /api/v1/inventory/chef`: Chef node and role JSON for `knife node|role from file`.
- **Filters** on every route: `types`, `layers`, `lifecycle`, `tags`, `sites`, `services` (id or code) and
  `attributes`. `groupBy` (Ansible only) picks the facets: site, type, layer, tag, service, lifecycle.
- **Clients** (`tools/inventory`, Python standard library only):
  - an Ansible dynamic-inventory script and an Ansible inventory plugin (`constructed`);
  - a salt-ssh roster writer and a salt-ssh roster module;
  - a Puppet ENC;
  - a Chef exporter that writes files for knife.
  - The README documents each, including the knife flow.
- **Console**: the Integrations screen ends with a "Configuration management inventory" card (en and ar). It shows:
  - the live node, site and service counts, read from the Ansible route with the user's token;
  - every tool's endpoint on this deployment, with its client and usage;
  - a download of each tool's document;
  - how to obtain a token and how to filter.
  - Settings → API lists the five new routes with their summaries in both languages.
- **Observability**:
  - `rest.<route>` spans and `openmap_rest_requests_total` / `openmap_rest_request_duration_seconds` by route;
  - `openmap_inventory_exports_total{tool}` and `openmap_inventory_nodes_total{tool}`;
  - spans `inventory.nodes`, `inventory.certname` and `inventory.membership`.

## Tests

| Test | What | Result |
| --- | --- | --- |
| T-620 `apps/api/src/inventory/inventory.formats.test.ts` | Merge of CIs naming one node, node name and address, group naming, Ansible / salt / Puppet / Chef formats against the contract schemas | 10/10 pass |
| T-621 `apps/api/src/inventory/yaml.test.ts` | YAML emitter: block style, quoting, YAML 1.1 reserved keys, escapes | 5/5 pass |
| T-622 `packages/contracts/src/inventory.test.ts` | Routes in the OpenAPI document with their media types, query parsing, port bound, group names | 4/4 pass (contracts suite 114/114) |
| T-623 `packages/sdk/src/index.test.ts` | SDK `inventory.*` calls (YAML-first routes asked for JSON) | 1/1 pass (SDK suite 4/4) |
| T-624 `apps/api/src/inventory/inventory.integration.test.ts` | Compose stack, own tenant: auth (401, automation token), Ansible content, every filter, a bad facet is a 400, roster YAML and JSON, ENC by certname in any case and a 404, Chef roles, metrics | 7/7 pass |
| T-625 `apps/api/src/inventory/inventory.tools.integration.test.ts` | The real tools through the shipped clients (below) | 4/4 pass |
| T-626 `apps/console/src/components/integrations/InventoryCard.test.tsx` | Card in en and ar: live counts with the bearer token, endpoint table, download | 3/3 pass (console suite 387/387) |
| T-627 `apps/console/e2e/inventory.spec.ts` | Playwright, en and ar projects: live preview response, endpoint table, the roster download is YAML, RTL screenshot | written, not run in this session |

Other checks:

- The REST integration test T-484 still passes after the shared route runner was extracted (3/3).
- `pnpm guard`: ok. `pnpm i18n:check`: en and ar in sync.
- Typecheck: api, console, contracts and sdk are clean.
- ESLint: clean on the new and changed source files of api, console, contracts and sdk. The findings left are in
  files this change did not write (`metrics.service.ts:96`, `sdk/src/index.ts:45,75`) and the usual "test file not
  in project" parse notes.

## The real tools (T-625)

The image is built from `tools/inventory/check/Dockerfile`, a throwaway image outside every compose profile. It ran
these versions (`versions.txt`):

```
ansible-inventory [core 2.20.11]
salt-ssh 3007.17 (Chlorine)
puppet 8.10.0
Chef Infra Client: 18.10.17      (knife 18.10.18)
chef-zero 15.1.11
```

How the run worked:

- The API ran in-process on the compose stack and listened on the host.
- The test tenant held the estate of `apps/api/src/inventory/__tests__/estate.ts`:
  - a site RYD with a rack;
  - host `app-01` in the rack;
  - host `esx-01` and the hypervisor that shares its FQDN;
  - a VM `vm-web-01` on that hypervisor, running the Payments application's component;
  - a VM `vm-batch-01` that knows its site (JED) only from its collector;
  - a switch, a retired host and a database.
- The container called that API through the shipped clients (`check/run.sh`), with a token for the tenant.

The outputs below come from that run. They are what the tools printed about OpenMap's answer, not fixtures.

**Ansible.** `ansible-inventory -i openmap.yml --graph` over the inventory plugin, with `keyed_groups` on
`openmap_attributes.osName`:

```
@all:
  |--@ungrouped:
  |--@openmap_site:
  |  |--@site_jed:
  |  |  |--vm-batch-01
  |  |--@site_ryd:
  |  |  |--app-01.inv.test
  |  |  |--esx-01.inv.test
  |  |  |--vm-web-01.inv.test
  |--@openmap_type:
  |  |--@type_host:
  |  |  |--app-01.inv.test
  |  |  |--esx-01.inv.test
  |  |--@type_network_device:
  |  |  |--core-sw-01
  |  |--@type_vm:
  |  |  |--vm-batch-01
  |  |  |--vm-web-01.inv.test
  |--@openmap_tag:
  |  |--@tag_hypervisor:
  |  |  |--esx-01.inv.test
  |  |--@tag_linux:
  |  |  |--app-01.inv.test
  |  |  |--vm-batch-01
  |  |  |--vm-web-01.inv.test
  |  |--@tag_pci:
  |  |  |--app-01.inv.test
  |  |--@tag_vmware:
  |  |  |--esx-01.inv.test
  |  |--@tag_web:
  |  |  |--vm-web-01.inv.test
  |--@openmap_service:
  |  |--@service_bs_payments:
  |  |  |--esx-01.inv.test
  |  |  |--vm-web-01.inv.test
  |--@os_RHEL:
  |  |--app-01.inv.test
  |--@os_unknown:
  |  |--core-sw-01
  |  |--vm-batch-01
  |  |--vm-web-01.inv.test
  |--@os_ESXi:
  |  |--esx-01.inv.test
```

- `ansible-inventory --list` read the same five hosts through the dynamic-inventory script and through the plugin.
  The test compared both against the API's hostvars and groups.
- Excerpt of the script's `--list`:

```json
"app-01.inv.test": {
    "ansible_host": "192.0.2.11",
    "openmap_attributes": { "osName": "RHEL", "osVersion": "9.4" },
    "openmap_code": "INV-7993F4F9",
    "openmap_layer": "hardware",
    "openmap_lifecycle": "managed",
    "openmap_merged_ids": [],
    "openmap_site": "RYD",
    "openmap_site_code": "RYD",
    "openmap_tags": ["linux", "pci"],
    "openmap_type": "host"
}
```

- `esx-01` appears once. The host and its hypervisor merged into one node: `openmap_merged_ids` holds the hypervisor's
  id, and the tags of both are kept.
- The service group holds the VM and the ESXi host, reached through the application → component → VM → hypervisor →
  host chain.
- Through the plugin, Ansible 2.20 marks inventory strings as `{"__ansible_unsafe": …}` in `--list`. It never
  trusts inventory data as a template. The marker is Ansible's own, not OpenMap's.

**Salt.**

- `openmap_roster.py --user ops --sudo` wrote the roster file.
- Salt's flat roster read the file (through Salt's own renderer, PyYAML) to the five targets.
- The `openmap` roster module, loaded from `extension_modules`, read the API live to the same five targets.
- `salt-ssh --roster-file <file> -H` listed the hosts it would connect to:

```
/out/salt-roster.yaml:
    ----------
    app-01.inv.test:
        192.0.2.11
    core-sw-01:
        192.0.2.31
    esx-01.inv.test:
        192.0.2.12
    vm-batch-01:
        192.0.2.22
    vm-web-01.inv.test:
        vm-web-01.inv.test
```

- Each target carried `user: ops`, `sudo: true` and the `openmap` grain (`minion_opts.grains`) with id, code, type,
  site, tags, services and attributes.

**Puppet.** `puppet node find app-01.inv.test --node_terminus exec --external_nodes openmap_enc.py --render-as json`
ran the exec terminus that a Puppet server uses with an ENC. Psych parsed the YAML. Below are the node's
classification and OpenMap's parameters; Puppet adds 26 facter facts of the container besides.

```json
{
  "name": "app-01.inv.test",
  "environment": "staging",
  "classes": { "role::app": {}, "profile::base": {} },
  "parameters": {
    "openmap_code": "INV-7993F4F9", "openmap_name": "app-01", "openmap_type": "host",
    "openmap_layer": "hardware", "openmap_lifecycle": "managed", "openmap_site": "RYD",
    "openmap_tags": ["linux", "pci"], "openmap_services": [],
    "openmap_attributes": { "osName": "RHEL", "osVersion": "9.4" }
  }
}
```

- A certname no CI has (`unknown-node.openmap.invalid`) got the ENC's empty classification: environment
  `production` and no classes.

**Chef.** `openmap_chef_export.py` wrote the files, and knife loaded them into chef-zero, roles first:

```
openmap: wrote 5 nodes and 3 roles to /tmp/chef
Updated Role openmap_service_bs_payments
Updated Role openmap_site_jed
Updated Role openmap_site_ryd
Updated Node app-01.inv.test
Updated Node core-sw-01
Updated Node esx-01.inv.test
Updated Node vm-batch-01
Updated Node vm-web-01.inv.test
```

- `knife node show app-01.inv.test -l` gave environment `prod` (the CI's `chefEnvironment`), run list
  `role[openmap_site_ryd]`, and the facts under `normal.openmap`.
- `knife search node 'run_list:role\[openmap_site_ryd\]'` and `knife search node 'openmap_site:RYD'` each returned
  `app-01`, `esx-01` and `vm-web-01`.
- The README's `knife exec` merge, run on a node that had a run list of its own (`recipe[own::base]`), kept that run
  list and wrote the OpenMap facts.

## Scale (the 100k-CI synthetic estate, tenant with 77,816 inventory CIs)

The routes were timed through the in-process API on the compose stack, one request after another, with impact
validation off:

| Request | Nodes | Body | Time |
| --- | --- | --- | --- |
| `/ansible?services=BS-MOBILE-BANKING` (cold: includes the membership walk) | 101 | 1.3 MB | 4.9 s |
| `/ansible` (everything) | 77,816 | 54 MB | 4.5 s |
| `/ansible?sites=HQ` | 6,196 | 4.0 MB | 2.0 s |
| `/chef?sites=HQ` | 6,196 | 3.7 MB | 2.0 s |
| `/puppet/nodes/esx-hq-c01-03.bank.local` | 1 | 0.6 KB | 0.2 s |

Ansible's groups first used array lookups, and the full inventory took 25 s. They now use sets, and the site walk
and site filter run inside the one SELECT, which brought it to 4.5 s.

On the shared stack, some cold runs answered 500 after the Prisma pool timeout (30 s). They failed to open a
Postgres connection through Docker Desktop's port forwarding while other suites ran. The same requests passed on
re-run.

## Not done here

- T-627 (Playwright, en and ar) is written and was not run in this session. The running console image predates this
  change, and the compose images are not rebuilt by this work. So there is no RTL screenshot yet:
  `apps/console/e2e/screenshots/inventory-ar.png` is produced when the spec runs.
- The real-tools check needs Docker. Without `INVENTORY_TOOLS_IMAGE`, T-625 reports itself skipped.
