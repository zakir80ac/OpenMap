#!/bin/sh
# REQ-IPAM-003 (ADR-055) — writes the TSIG key from the environment, seeds the zone file on first start (later updates
# live in the journal beside it) and runs BIND in the foreground.
set -eu
: "${DNS_LAB_TSIG_SECRET:?DNS_LAB_TSIG_SECRET is required (base64)}"
mkdir -p /run/dns-lab
printf 'key "openmap-sync" {\n  algorithm hmac-sha256;\n  secret "%s";\n};\n' "$DNS_LAB_TSIG_SECRET" > /run/dns-lab/openmap-sync.key
chown -R bind:bind /run/dns-lab /var/lib/bind
chmod 0640 /run/dns-lab/openmap-sync.key
if [ ! -f /var/lib/bind/lab.openmap.test.db ]; then
  cp /etc/bind/lab/lab.openmap.test.db /var/lib/bind/lab.openmap.test.db
  chown bind:bind /var/lib/bind/lab.openmap.test.db
fi
exec /usr/sbin/named -g -c /etc/bind/lab/named.conf -u bind
