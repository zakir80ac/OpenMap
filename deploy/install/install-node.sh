#!/usr/bin/env sh
# REQ-DISC-031 — installs a bare-metal Discovery Node on Linux (systemd): binaries, collectors, user, directories,
# the environment file and the unit. Run as root from an unpacked release directory that holds `openmap-node` and a
# `collectors/` folder (or from the repository after building them).
#   install-node.sh --node <nodeId> --site <siteCode> --scheduler <https://scheduler.example:4200> --token <enrol token> [--ca <ca.crt>]
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
node_id=""; site=""; scheduler=""; token=""; ca=""
while [ $# -gt 0 ]; do
  case "$1" in
    --node) node_id="$2"; shift 2 ;;
    --site) site="$2"; shift 2 ;;
    --scheduler) scheduler="$2"; shift 2 ;;
    --token) token="$2"; shift 2 ;;
    --ca) ca="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$node_id" ] && [ -n "$site" ] && [ -n "$scheduler" ] && [ -n "$token" ] || { echo "usage: install-node.sh --node <id> --site <code> --scheduler <url> --token <token> [--ca <ca.crt>]" >&2; exit 2; }
bin_src="$(dirname "$here")/bin/openmap-node"; [ -x "$bin_src" ] || bin_src="$here/openmap-node"
collectors_src="$(dirname "$here")/collectors"; [ -d "$collectors_src" ] || collectors_src="$here/collectors"
[ -x "$bin_src" ] || { echo "openmap-node binary not found next to this script" >&2; exit 1; }

id openmap >/dev/null 2>&1 || useradd --system --home-dir /var/lib/openmap --shell /usr/sbin/nologin openmap
install -d -m 0755 /opt/openmap/bin /opt/openmap/collectors
install -d -m 0750 -o openmap -g openmap /etc/openmap /etc/openmap/pki /var/lib/openmap /var/lib/openmap/evidence
install -m 0755 "$bin_src" /opt/openmap/bin/openmap-node
if [ -d "$collectors_src" ]; then
  for c in "$collectors_src"/*; do [ -f "$c" ] && install -m 0755 "$c" /opt/openmap/collectors/; done
fi
if [ -n "$ca" ]; then install -m 0644 -o openmap -g openmap "$ca" /etc/openmap/bootstrap-ca.crt; fi

umask 077
cat > /etc/openmap/node.env <<EOF
OPENMAP_NODE_ID=$node_id
OPENMAP_SITE_CODE=$site
OPENMAP_SCHEDULER_URL=$scheduler
OPENMAP_COLLECTORS_DIR=/opt/openmap/collectors
OPENMAP_EVIDENCE_DIR=/var/lib/openmap/evidence
NODE_MTLS_CA_PATH=/etc/openmap/pki/ca.crt
NODE_MTLS_CERT_PATH=/etc/openmap/pki/node.crt
NODE_MTLS_KEY_PATH=/etc/openmap/pki/node.key
$( [ -n "$ca" ] && echo "OPENMAP_BOOTSTRAP_CA_PATH=/etc/openmap/bootstrap-ca.crt" )
EOF
chown openmap:openmap /etc/openmap/node.env

# Enrol once with the one-time token (never stored), then install and start the unit.
OPENMAP_ENROL_TOKEN="$token" su -s /bin/sh openmap -c "/opt/openmap/bin/openmap-node enrol"
install -m 0644 "$here/openmap-node.service" /etc/systemd/system/openmap-node.service
systemctl daemon-reload
systemctl enable --now openmap-node.service
systemctl --no-pager --lines=3 status openmap-node.service || true
echo "OpenMap Discovery Node $node_id installed; settings in /etc/openmap/node.env"
