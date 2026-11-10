# REQ-INT-011 (ADR-072) — OpenMap as an Ansible inventory plugin (the configuration-file form of the inventory script).
# Put this file in an inventory plugin directory (ANSIBLE_INVENTORY_PLUGINS, or inventory_plugins/ next to the
# playbook), enable it (ANSIBLE_INVENTORY_ENABLED=openmap or [inventory] enable_plugins), and point -i at a file named
# *openmap.yml such as the example beside this directory.
from __future__ import annotations

DOCUMENTATION = r"""
name: openmap
short_description: OpenMap CMDB inventory source
description:
  - Reads hosts, groups and host variables from OpenMap (GET /api/v1/inventory/ansible).
  - Hosts are named by FQDN, else by CI name; ansible_host is the management IP, else the FQDN, else the primary IP.
  - Groups are site_*, type_*, layer_*, lifecycle_*, tag_* and service_* under parents openmap_site, openmap_type and so on.
extends_documentation_fragment:
  - constructed
options:
  plugin:
    description: Marks the file as an OpenMap inventory source.
    required: true
    choices: ["openmap"]
  url:
    description: The OpenMap API origin (PUBLIC_API_URL of the deployment).
    required: true
    env:
      - name: OPENMAP_URL
  token:
    description: A bearer token. Leave it out to use the client-credentials grant below.
    env:
      - name: OPENMAP_TOKEN
  token_url:
    description: The realm's token endpoint, for the client-credentials grant.
    env:
      - name: OPENMAP_TOKEN_URL
  client_id:
    description: The automation client's id, for the client-credentials grant.
    env:
      - name: OPENMAP_CLIENT_ID
  client_secret:
    description: The automation client's secret, for the client-credentials grant.
    env:
      - name: OPENMAP_CLIENT_SECRET
  ca_file:
    description: CA bundle that signs the API's certificate, when it is not in the system store.
    env:
      - name: OPENMAP_CA_FILE
  timeout:
    description: Seconds to wait for the API.
    type: int
    default: 60
  filters:
    description: >-
      The route's filters, each a list: types, layers, lifecycle, tags, sites, services (id or code), attributes
      (the CI attributes copied into openmap_attributes).
    type: dict
    default: {}
  group_by:
    description: Facets to group by (site, type, layer, tag, service, lifecycle).
    type: list
    elements: str
    default: ["site", "type", "tag", "service"]
"""

EXAMPLES = r"""
# openmap.yml
plugin: openmap
url: "{{ lookup('env', 'OPENMAP_URL') }}"
filters:
  sites: [HQ]
  tags: [pci]
group_by: [site, service]
keyed_groups:
  - key: openmap_attributes.osName
    prefix: os
"""

import json
import urllib.parse

from ansible.errors import AnsibleError
from ansible.module_utils.urls import open_url
from ansible.plugins.inventory import BaseInventoryPlugin, Constructable

ROUTE = "/api/v1/inventory/ansible"
META = "_meta"


class InventoryModule(BaseInventoryPlugin, Constructable):
    NAME = "openmap"

    def verify_file(self, path):
        return super().verify_file(path) and path.endswith(("openmap.yml", "openmap.yaml"))

    def _bearer(self):
        token = self.get_option("token")
        if token:
            return token
        token_url, client_id, secret = (self.get_option(k) for k in ("token_url", "client_id", "client_secret"))
        if not (token_url and client_id and secret):
            raise AnsibleError("openmap: set token, or token_url, client_id and client_secret")
        form = urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": client_id, "client_secret": secret})
        res = open_url(token_url, data=form, method="POST", timeout=self.get_option("timeout"), ca_path=self.get_option("ca_file"))
        return json.loads(res.read())["access_token"]

    def _fetch(self):
        params = {k: ",".join(str(x) for x in (v if isinstance(v, list) else [v])) for k, v in (self.get_option("filters") or {}).items()}
        params["groupBy"] = ",".join(self.get_option("group_by"))
        url = self.get_option("url").rstrip("/") + ROUTE + "?" + urllib.parse.urlencode(params)
        try:
            res = open_url(url, headers={"Authorization": "Bearer " + self._bearer(), "Accept": "application/json"}, timeout=self.get_option("timeout"), ca_path=self.get_option("ca_file"))
        except Exception as err:
            raise AnsibleError("openmap: " + str(err))
        return json.loads(res.read())

    def parse(self, inventory, loader, path, cache=True):
        super().parse(inventory, loader, path, cache)
        self._read_config_data(path)
        data = self._fetch()
        hostvars = data.get(META, {}).get("hostvars", {})
        groups = {name: group for name, group in data.items() if name != META}
        for name in groups:
            self.inventory.add_group(name)
        for name, group in groups.items():
            for child in group.get("children", []):
                self.inventory.add_child(name, child)
            for host in group.get("hosts", []):
                self.inventory.add_host(host, group=name)
            for key, value in group.get("vars", {}).items():
                self.inventory.set_variable(name, key, value)
        strict = self.get_option("strict")
        for host, variables in hostvars.items():
            self.inventory.add_host(host)
            for key, value in variables.items():
                self.inventory.set_variable(host, key, value)
            self._set_composite_vars(self.get_option("compose"), variables, host, strict=strict)
            self._add_host_to_composed_groups(self.get_option("groups"), variables, host, strict=strict)
            self._add_host_to_keyed_groups(self.get_option("keyed_groups"), variables, host, strict=strict)
