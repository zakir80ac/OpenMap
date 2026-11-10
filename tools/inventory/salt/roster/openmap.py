# REQ-INT-011 (ADR-072) — OpenMap as a salt-ssh roster module: targets come live from GET /api/v1/inventory/salt
# (format=json) on every run, matched like the flat roster (glob, pcre, list, range).
#
# Install: copy to <extension_modules>/roster/openmap.py, then in the master configuration
#   roster: openmap
#   openmap_url: https://openmap.example          # or OPENMAP_URL
#   openmap_query: sites=HQ&tags=pci&user=ops     # optional, or OPENMAP_QUERY
# and the token in OPENMAP_TOKEN (or OPENMAP_TOKEN_URL, OPENMAP_CLIENT_ID, OPENMAP_CLIENT_SECRET). OPENMAP_CA_FILE names
# a CA bundle when the API's certificate is not in the system store.
import json
import logging
import os
import ssl
import urllib.parse
import urllib.request

log = logging.getLogger(__name__)

ROUTE = "/api/v1/inventory/salt"
DEFAULT_TIMEOUT_SECONDS = 60


def __virtual__():
    return "openmap"


def _setting(name):
    return __opts__.get("openmap_" + name) or os.environ.get("OPENMAP_" + name.upper())  # noqa: F821 (injected by the loader)


def _context():
    ca = _setting("ca_file")
    return ssl.create_default_context(cafile=ca) if ca else ssl.create_default_context()


def _bearer(timeout):
    token = _setting("token")
    if token:
        return token
    token_url, client_id, secret = _setting("token_url"), _setting("client_id"), _setting("client_secret")
    if not (token_url and client_id and secret):
        raise RuntimeError("openmap roster: set the token, or token_url, client_id and client_secret")
    form = urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": client_id, "client_secret": secret}).encode()
    with urllib.request.urlopen(urllib.request.Request(token_url, data=form, method="POST"), timeout=timeout, context=_context()) as res:
        return json.load(res)["access_token"]


def targets(tgt, tgt_type="glob", **kwargs):
    base = _setting("url")
    if not base:
        raise RuntimeError("openmap roster: set openmap_url or OPENMAP_URL")
    timeout = float(_setting("timeout") or DEFAULT_TIMEOUT_SECONDS)
    params = urllib.parse.parse_qsl(_setting("query") or "") + [("format", "json")]
    url = base.rstrip("/") + ROUTE + "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"Authorization": "Bearer " + _bearer(timeout), "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout, context=_context()) as res:
        roster = json.load(res)
    log.debug("openmap roster: %d targets", len(roster))
    # Matched as the flat roster matches, through the loader (which gives the matcher the master options).
    return __utils__["roster_matcher.targets"](roster, tgt, tgt_type, "ipv4")  # noqa: F821
