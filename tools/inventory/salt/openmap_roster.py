#!/usr/bin/env python3
# REQ-INT-011 (ADR-072) — writes OpenMap's salt-ssh flat roster (GET /api/v1/inventory/salt, YAML).
#
#   openmap_roster.py -o /etc/salt/roster --user ops --sudo
#   salt-ssh --roster-file /etc/salt/roster 'web-*' test.ping
#
# Each minion id is the node's FQDN (else its CI name) with host = management IP, else FQDN, else primary IP, and
# OpenMap's facts as the `openmap` grain. For a live roster without a file, use the roster module in roster/openmap.py.
# Configuration: OPENMAP_URL, OPENMAP_TOKEN (or OPENMAP_TOKEN_URL, OPENMAP_CLIENT_ID, OPENMAP_CLIENT_SECRET),
# OPENMAP_QUERY (types=host,vm&sites=HQ&tags=pci), OPENMAP_CA_FILE, OPENMAP_TIMEOUT, as for the Ansible script.
import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

ROUTE = "/api/v1/inventory/salt"
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


def main():
    parser = argparse.ArgumentParser(description="OpenMap roster for salt-ssh")
    parser.add_argument("-o", "--output", help="file to write (default: standard output)")
    parser.add_argument("--user", help="SSH user of every target")
    parser.add_argument("--port", type=int, help="SSH port of every target")
    parser.add_argument("--sudo", action="store_true", help="run commands with sudo")
    args = parser.parse_args()
    base = os.environ.get("OPENMAP_URL")
    if not base:
        sys.exit("openmap: set OPENMAP_URL to the API origin")
    params = urllib.parse.parse_qsl(os.environ.get("OPENMAP_QUERY", ""))
    params += [(k, v) for k, v in (("user", args.user), ("port", args.port), ("sudo", "true" if args.sudo else None)) if v is not None]
    url = base.rstrip("/") + ROUTE + "?" + urllib.parse.urlencode(params + [("format", "yaml")])
    request = urllib.request.Request(url, headers={"Authorization": "Bearer " + bearer(), "Accept": "application/yaml"})
    try:
        with urllib.request.urlopen(request, timeout=timeout(), context=ssl_context()) as res:
            roster = res.read().decode()
    except urllib.error.HTTPError as err:
        sys.exit("openmap: " + str(err.code) + " " + err.read().decode(errors="replace"))
    if args.output:
        with open(args.output, "w", encoding="utf-8") as out:
            out.write(roster)
    else:
        sys.stdout.write(roster)


if __name__ == "__main__":
    main()
