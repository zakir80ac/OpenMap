#!/usr/bin/env python3
# REQ-INT-011 (ADR-072) — OpenMap as a Puppet external node classifier.
#
# puppet.conf on the primary server:
#   [server]
#   node_terminus = exec
#   external_nodes = /etc/puppetlabs/puppet/openmap_enc.py
#
# Puppet runs it with the agent's certname; it prints GET /api/v1/inventory/puppet/nodes/{certname} (YAML): the classes
# in the CI's puppetClasses attribute, OpenMap's facts as top-scope $openmap_* parameters, and the environment (the
# CI's puppetEnvironment attribute, else OPENMAP_PUPPET_ENVIRONMENT, else production). A certname no CI has gets an
# empty classification (the node is then classified by site.pp alone) unless OPENMAP_ENC_UNKNOWN=fail, which makes
# Puppet refuse the catalog. Configuration: OPENMAP_URL, OPENMAP_TOKEN (or OPENMAP_TOKEN_URL, OPENMAP_CLIENT_ID,
# OPENMAP_CLIENT_SECRET), OPENMAP_CA_FILE, OPENMAP_TIMEOUT, as for the Ansible script; Puppet's exec terminus passes
# no environment of its own, so set them where the server's service reads its environment.
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

ROUTE = "/api/v1/inventory/puppet/nodes/"
DEFAULT_TIMEOUT_SECONDS = 60
NOT_FOUND = 404
EMPTY_CLASSIFICATION = "---\nclasses: {}\nparameters: {}\n"


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
    if len(sys.argv) != 2:
        sys.exit("usage: openmap_enc.py <certname>")
    base = os.environ.get("OPENMAP_URL")
    if not base:
        sys.exit("openmap: set OPENMAP_URL to the API origin")
    params = [("format", "yaml")]
    environment = os.environ.get("OPENMAP_PUPPET_ENVIRONMENT")
    if environment:
        params.append(("environment", environment))
    url = base.rstrip("/") + ROUTE + urllib.parse.quote(sys.argv[1], safe="") + "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"Authorization": "Bearer " + bearer(), "Accept": "application/yaml"})
    try:
        with urllib.request.urlopen(request, timeout=timeout(), context=ssl_context()) as res:
            sys.stdout.write(res.read().decode())
    except urllib.error.HTTPError as err:
        if err.code == NOT_FOUND and os.environ.get("OPENMAP_ENC_UNKNOWN") != "fail":
            sys.stdout.write(EMPTY_CLASSIFICATION)
            return
        sys.exit("openmap: " + str(err.code) + " " + err.read().decode(errors="replace"))


if __name__ == "__main__":
    main()
