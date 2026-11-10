# OpenMap inventory clients (REQ-INT-011, ADR-072)

These clients feed Ansible, SaltStack, Puppet and Chef from the CMDB. They call the REST routes under
`/api/v1/inventory` and print what the tool reads. They use the Python 3 standard library only, so nothing has to
be installed beside the tool.

## Authentication and filters (every client)

| Variable | Meaning |
| --- | --- |
| `OPENMAP_URL` | The API origin: `PUBLIC_API_URL` of the deployment (Settings → API shows it). |
| `OPENMAP_TOKEN` | A bearer token. |
| `OPENMAP_TOKEN_URL`, `OPENMAP_CLIENT_ID`, `OPENMAP_CLIENT_SECRET` | Instead of a token: the realm's token endpoint (`<PUBLIC_KEYCLOAK_URL>/realms/<realm>/protocol/openid-connect/token`) and the `openmap-automation` client's credentials. The client fetches a token with the client-credentials grant. Keep the secret in OpenBao (apps/api/README.md, "API tokens"). |
| `OPENMAP_QUERY` | Narrows the inventory, written as a query string. The lists are comma-separated: `types`, `layers`, `lifecycle`, `tags`, `sites`, `services` (id or code). `attributes` names the CI attributes copied into the variables. `groupBy` (Ansible only) picks facets from site, type, layer, tag, service and lifecycle. Example: `sites=HQ&tags=pci&groupBy=site,service`. |
| `OPENMAP_CA_FILE` | The CA bundle that signs the API's certificate, when the system store lacks it. |
| `OPENMAP_TIMEOUT` | Seconds to wait for the API (default 60). |

Any signed-in role can read the inventory, so an analyst's or the automation client's token is enough.

What every tool sees:

- Nodes are named by FQDN in lower case, else by CI name.
- The connection address is the management IP, else the FQDN, else the primary IP.
- The facts are the CI id, code, type, layer, lifecycle, site, tags, business services and the requested attributes.
- Classes and environments are CI attributes you set on the CI: `puppetClasses` (an array, or a comma-separated
  string), `puppetEnvironment` and `chefEnvironment`.

## Ansible

There are two ways to connect Ansible.

The dynamic-inventory script:

```sh
ansible-inventory -i tools/inventory/ansible/openmap_inventory.py --graph
ansible-playbook  -i tools/inventory/ansible/openmap_inventory.py site.yml --limit 'site_hq:&service_bs_payments'
```

The inventory plugin, configured by `ansible/openmap.yml` (it supports `compose`, `groups` and `keyed_groups`):

```sh
export ANSIBLE_INVENTORY_PLUGINS=tools/inventory/ansible/plugins/inventory ANSIBLE_INVENTORY_ENABLED=openmap
ansible-inventory -i tools/inventory/ansible/openmap.yml --list
```

Groups:

- One group per facet value: `site_<code>`, `type_<type>`, `tag_<tag>` and `service_<code>`, plus `layer_*` and
  `lifecycle_*` on request.
- The value groups sit under parents `openmap_site`, `openmap_type` and so on.
- Host variables: `ansible_host` and `openmap_*`.

## SaltStack (salt-ssh)

To use a roster file:

```sh
python3 tools/inventory/salt/openmap_roster.py -o /etc/salt/roster --user ops --sudo
salt-ssh --roster-file /etc/salt/roster 'web-*' test.ping
```

To read the roster live on every run, use the roster module instead. Copy `salt/roster/openmap.py` to
`<extension_modules>/roster/`, then set `roster: openmap` in the master configuration (with `openmap_url` and
`openmap_query`, or the environment variables above).

OpenMap's facts are in the `openmap` grain of each target (`minion_opts.grains`).

## Puppet

The ENC runs on the primary server:

```ini
# puppet.conf
[server]
node_terminus  = exec
external_nodes = /etc/puppetlabs/puppet/openmap_enc.py
```

Set the variables above in the server service's environment. `OPENMAP_PUPPET_ENVIRONMENT` is the environment for
nodes whose CI names none.

A certname that no CI has gets an empty classification, so site.pp alone classifies the node. Set
`OPENMAP_ENC_UNKNOWN=fail` to make Puppet refuse such a node instead.

To check one node without a server:

```sh
puppet node find web-01.bank.local --node_terminus exec --external_nodes tools/inventory/puppet/openmap_enc.py --render-as yaml
```

## Chef (knife)

```sh
python3 tools/inventory/chef/openmap_chef_export.py --out openmap-chef
knife role from file openmap-chef/roles/*.json    # roles first: the nodes' run lists name them
knife node from file openmap-chef/nodes/*.json
knife search node 'run_list:role\[openmap_site_hq\]'
knife search node 'openmap_site:HQ'
```

What the export contains:

- Each node carries OpenMap's facts under `normal.openmap`.
- Its run list holds `role[openmap_site_<code>]` and `role[openmap_service_<code>]`.
- Each role has an empty run list of its own. Attach cookbooks to it with `knife role edit`.

`knife node from file` replaces a node's run list and normal attributes. Use it for nodes OpenMap owns. For a node
Chef already runs, merge only the facts:

```sh
knife exec -E 'n = nodes.find("name:web-01.bank.local").first; n.normal["openmap"] = JSON.parse(File.read("openmap-chef/nodes/web-01.bank.local.json"))["normal"]["openmap"]; n.save'
```

## Checking against the real tools

`check/Dockerfile` builds a throwaway image with ansible-core, Salt, Puppet, and knife with chef-zero.
`check/run.sh` runs every client above through the real tools against a live API.

The API integration test T-625 (`apps/api/src/inventory/inventory.tools.integration.test.ts`) drives the check:

```sh
docker build -t openmap-inventory-check:local tools/inventory/check
INVENTORY_TOOLS_IMAGE=openmap-inventory-check:local pnpm --filter @openmap/api test:integration -- src/inventory/inventory.tools.integration.test.ts
```

The image is for tests only and is not part of any compose profile.
