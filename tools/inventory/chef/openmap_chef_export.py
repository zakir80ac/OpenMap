#!/usr/bin/env python3
# REQ-INT-011 (ADR-072) — writes OpenMap's Chef export (GET /api/v1/inventory/chef) as one JSON file per node and role,
# the files knife loads:
#
#   openmap_chef_export.py --out openmap-chef
#   knife role from file openmap-chef/roles/*.json      # roles first: the nodes' run lists name them
#   knife node from file openmap-chef/nodes/*.json
#   knife search node 'role:openmap_site_hq'
#
# Each node carries OpenMap's facts under normal.openmap and its site and business-service roles in its run list;
# `knife node from file` replaces a node's run list and normal attributes, so import into nodes OpenMap owns, or merge
# with `knife exec` for nodes Chef already runs. Configuration: OPENMAP_URL, OPENMAP_TOKEN (or OPENMAP_TOKEN_URL,
# OPENMAP_CLIENT_ID, OPENMAP_CLIENT_SECRET), OPENMAP_QUERY, OPENMAP_CA_FILE, OPENMAP_TIMEOUT, as for the Ansible script.
import argparse
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

ROUTE = "/api/v1/inventory/chef"
DEFAULT_TIMEOUT_SECONDS = 60
UNSAFE_FILE_CHARACTERS = re.compile(r"[^A-Za-z0-9._-]")


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


def write(directory, items):
    os.makedirs(directory, exist_ok=True)
    for item in items:
        with open(os.path.join(directory, UNSAFE_FILE_CHARACTERS.sub("_", item["name"]) + ".json"), "w", encoding="utf-8") as out:
            json.dump(item, out, indent=2, ensure_ascii=False)
            out.write("\n")


def main():
    parser = argparse.ArgumentParser(description="OpenMap nodes and roles for knife")
    parser.add_argument("--out", required=True, help="directory to write nodes/ and roles/ into")
    parser.add_argument("--environment", help="Chef environment of nodes whose CI names none (default _default)")
    args = parser.parse_args()
    base = os.environ.get("OPENMAP_URL")
    if not base:
        sys.exit("openmap: set OPENMAP_URL to the API origin")
    params = urllib.parse.parse_qsl(os.environ.get("OPENMAP_QUERY", ""))
    if args.environment:
        params.append(("environment", args.environment))
    url = base.rstrip("/") + ROUTE + ("?" + urllib.parse.urlencode(params) if params else "")
    request = urllib.request.Request(url, headers={"Authorization": "Bearer " + bearer(), "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout(), context=ssl_context()) as res:
            export = json.load(res)
    except urllib.error.HTTPError as err:
        sys.exit("openmap: " + str(err.code) + " " + err.read().decode(errors="replace"))
    write(os.path.join(args.out, "nodes"), export["nodes"])
    write(os.path.join(args.out, "roles"), export["roles"])
    print("openmap: wrote " + str(len(export["nodes"])) + " nodes and " + str(len(export["roles"])) + " roles to " + args.out)


if __name__ == "__main__":
    main()
