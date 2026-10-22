#!/usr/bin/env sh
# REQ-DISC-004 — installs the host agent on Linux (systemd) or macOS (launchd): binary, directories, environment
# file, enrolment with the one-time token, and the service. Run as root from an unpacked release directory.
#   install-agent.sh --node-url <https://node.site.example:4300> --token <enrol token> --ca <discovery ca.crt> [--agent-id <fqdn>] [--interval-ms <n>]
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
node_url=""; token=""; ca=""; agent_id="$(hostname -f 2>/dev/null || hostname)"; interval=""
while [ $# -gt 0 ]; do
  case "$1" in
    --node-url) node_url="$2"; shift 2 ;;
    --token) token="$2"; shift 2 ;;
    --ca) ca="$2"; shift 2 ;;
    --agent-id) agent_id="$2"; shift 2 ;;
    --interval-ms) interval="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$node_url" ] && [ -n "$token" ] && [ -n "$ca" ] || { echo "usage: install-agent.sh --node-url <url> --token <token> --ca <ca.crt> [--agent-id <fqdn>] [--interval-ms <n>]" >&2; exit 2; }
bin_src="$(dirname "$here")/bin/openmap-agent"; [ -x "$bin_src" ] || bin_src="$here/openmap-agent"
[ -x "$bin_src" ] || { echo "openmap-agent binary not found next to this script" >&2; exit 1; }

install -d -m 0755 /opt/openmap/bin
install -d -m 0700 /etc/openmap/agent
install -m 0755 "$bin_src" /opt/openmap/bin/openmap-agent
install -m 0644 "$ca" /etc/openmap/agent/bootstrap-ca.crt
umask 077
cat > /etc/openmap/agent/agent.env <<EOF
OPENMAP_AGENT_NODE_URL=$node_url
OPENMAP_AGENT_ID=$agent_id
OPENMAP_BOOTSTRAP_CA_PATH=/etc/openmap/agent/bootstrap-ca.crt
$( [ -n "$interval" ] && echo "OPENMAP_AGENT_INTERVAL_MS=$interval" )
EOF

OPENMAP_ENROL_TOKEN="$token" /opt/openmap/bin/openmap-agent enrol

case "$(uname -s)" in
  Darwin)
    install -m 0644 "$here/com.openmap.agent.plist" /Library/LaunchDaemons/com.openmap.agent.plist
    launchctl bootout system /Library/LaunchDaemons/com.openmap.agent.plist 2>/dev/null || true
    launchctl bootstrap system /Library/LaunchDaemons/com.openmap.agent.plist
    ;;
  *)
    install -m 0644 "$here/openmap-agent.service" /etc/systemd/system/openmap-agent.service
    systemctl daemon-reload
    systemctl enable --now openmap-agent.service
    systemctl --no-pager --lines=3 status openmap-agent.service || true
    ;;
esac
echo "OpenMap agent $agent_id installed; settings in /etc/openmap/agent/agent.env"
