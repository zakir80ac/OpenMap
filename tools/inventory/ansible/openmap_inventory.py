#!/usr/bin/env python3
# REQ-INT-011 (ADR-072) — OpenMap as an Ansible dynamic inventory script.
#
#   ansible-inventory -i openmap_inventory.py --list
#   ansible-playbook  -i openmap_inventory.py site.yml --limit site_hq
#
# It prints GET /api/v1/inventory/ansible for --list (hosts with ansible_host and openmap_* hostvars under _meta,
# groups site_*, type_*, tag_*, service_*) and one host's vars for --host. Configuration comes from the environment
# only (standard library, no dependencies):
#   OPENMAP_URL            API origin, for example the value of PUBLIC_API_URL (required)
#   OPENMAP_TOKEN          a bearer token, or
#   OPENMAP_TOKEN_URL, OPENMAP_CLIENT_ID, OPENMAP_CLIENT_SECRET
#                          the realm's token endpoint and the automation client's credentials (client-credentials grant)
#   OPENMAP_QUERY          filter and grouping, as a query string: types=host,vm&sites=HQ&tags=pci&groupBy=site,service
#   OPENMAP_CA_FILE        CA bundle that signs the API's certificate, when it is not in the system store
#   OPENMAP_TIMEOUT        seconds to wait for the API (default 60)
import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

ROUTE = "/api/v1/inventory/ansible"
DEFAULT_TIMEOUT_SECONDS = 60


def ssl_context():
    ca = os.environ.get("OPENMAP_CA_FILE")
    return ssl.create_default_context(cafile=ca) if ca else ssl.create_default_context()


def timeout():
    return float(os.environ.get("OPENMAP_TIMEOUT", DEFAULT_TIMEOUT_SECONDS))


def bearer():
    token = os.environ.get("OPENMAP_TOKEN")
    if token:
        return token
    token_url = os.environ.get("OPENMAP_TOKEN_URL")
    client_id = os.environ.get("OPENMAP_CLIENT_ID")
    secret = os.environ.get("OPENMAP_CLIENT_SECRET")
    if not (token_url and client_id and secret):
        sys.exit("openmap: set OPENMAP_TOKEN, or OPENMAP_TOKEN_URL, OPENMAP_CLIENT_ID and OPENMAP_CLIENT_SECRET")
    form = urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": client_id, "client_secret": secret}).encode()
    with urllib.request.urlopen(urllib.request.Request(token_url, data=form, method="POST"), timeout=timeout(), context=ssl_context()) as res:
        return json.load(res)["access_token"]


def fetch():
    base = os.environ.get("OPENMAP_URL")
    if not base:
        sys.exit("openmap: set OPENMAP_URL to the API origin")
    query = os.environ.get("OPENMAP_QUERY", "")
    url = base.rstrip("/") + ROUTE + ("?" + query if query else "")
    request = urllib.request.Request(url, headers={"Authorization": "Bearer " + bearer(), "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout(), context=ssl_context()) as res:
            return json.load(res)
    except urllib.error.HTTPError as err:
        sys.exit("openmap: " + str(err.code) + " " + err.read().decode(errors="replace"))


def main():
    parser = argparse.ArgumentParser(description="OpenMap dynamic inventory for Ansible")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--list", action="store_true", help="every host and group")
    group.add_argument("--host", help="one host's variables")
    args = parser.parse_args()
    inventory = fetch()
    if args.list:
        json.dump(inventory, sys.stdout)
    else:
        json.dump(inventory.get("_meta", {}).get("hostvars", {}).get(args.host, {}), sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
