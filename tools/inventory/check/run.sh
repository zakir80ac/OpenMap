#!/bin/sh
# REQ-INT-011 (ADR-072) — runs the real configuration-management tools against a live OpenMap inventory, inside the
# image built from tools/inventory/check/Dockerfile, and leaves every tool's own output in /out:
#   ansible-script.json   ansible-inventory --list over the dynamic-inventory script
#   ansible-plugin.json   ansible-inventory --list over the inventory plugin (keyed_groups on openmap_attributes)
#   ansible-graph.txt     ansible-inventory --graph over the plugin
#   salt-roster.yaml      the roster file openmap_roster.py wrote
#   salt-targets.json     targets Salt's flat roster read from that file, and its openmap roster module read live
#   salt-ssh-hosts.txt    salt-ssh --roster-file <file> -H (the hosts salt-ssh would connect to)
#   puppet-node.json      puppet node find <certname> through the exec terminus running openmap_enc.py
#   puppet-unknown.json   the same for a certname OpenMap does not know
#   chef-nodes.json       knife node list after knife role|node from file over openmap_chef_export.py's files
#   chef-node.json        knife node show of one node; chef-search.json: knife search node run_list:role[<site role>]
#   chef-search-site.json knife search node openmap_site:<site code> (the facts are searchable attributes)
#   chef-merged.json      the node after the README's knife exec merge into a node with a run list of its own
#   versions.txt          every tool's version
# Inputs (environment): OPENMAP_URL, OPENMAP_TOKEN, CERTNAME (a node to classify), SITE_ROLE (a Chef role to search),
# SITE_CODE (the site code of that role).
set -eu
INV=/inv
OUT=/out
CHEF_ZERO_PORT=8889
CHEF_ZERO_WAIT_SECONDS=30

{
  ansible-inventory --version | head -n 1
  salt-ssh --version
  echo "puppet $(puppet --version)"
  knife --version
  echo "chef-zero $(chef-zero --version)"
} > "$OUT/versions.txt" 2>&1

# Ansible: the script, then the plugin.
ansible-inventory -i "$INV/ansible/openmap_inventory.py" --list > "$OUT/ansible-script.json"
cat > /tmp/openmap.yml <<EOF
plugin: openmap
group_by: [site, type, tag, service]
keyed_groups:
  - key: openmap_attributes.osName | default('unknown')
    prefix: os
EOF
export ANSIBLE_INVENTORY_PLUGINS="$INV/ansible/plugins/inventory" ANSIBLE_INVENTORY_ENABLED=openmap ANSIBLE_INVENTORY_UNPARSED_FAILED=true
ansible-inventory -i /tmp/openmap.yml --list > "$OUT/ansible-plugin.json"
ansible-inventory -i /tmp/openmap.yml --graph > "$OUT/ansible-graph.txt"
unset ANSIBLE_INVENTORY_PLUGINS ANSIBLE_INVENTORY_ENABLED

# Salt: the roster file through the flat roster and salt-ssh, and the roster module live.
python3 "$INV/salt/openmap_roster.py" -o "$OUT/salt-roster.yaml" --user ops --sudo
python3 "$INV/check/salt_targets.py" "$OUT/salt-roster.yaml" "$INV/salt" > "$OUT/salt-targets.json"
mkdir -p /tmp/salt
salt-ssh --config-dir /tmp/salt --roster-file "$OUT/salt-roster.yaml" -H > "$OUT/salt-ssh-hosts.txt" 2>&1 || true

# Puppet: the exec node terminus runs the ENC as a Puppet server would.
mkdir -p /tmp/puppet/environments/production /tmp/puppet/environments/staging
PUPPET="--confdir /tmp/puppet/conf --vardir /tmp/puppet/var --environmentpath /tmp/puppet/environments --node_terminus exec --external_nodes $INV/puppet/openmap_enc.py --render-as json"
# shellcheck disable=SC2086
puppet node find "$CERTNAME" $PUPPET > "$OUT/puppet-node.json"
# shellcheck disable=SC2086
puppet node find "unknown-node.openmap.invalid" $PUPPET > "$OUT/puppet-unknown.json"

# Chef: an in-memory chef-zero server, roles before nodes.
chef-zero --port "$CHEF_ZERO_PORT" > /tmp/chef-zero.log 2>&1 &
ruby -ropenssl -e 'print OpenSSL::PKey::RSA.new(2048).to_pem' > /tmp/knife.pem
KNIFE="--server-url http://127.0.0.1:$CHEF_ZERO_PORT --user pivotal --key /tmp/knife.pem --config-option ssl_verify_mode=verify_none"
i=0
until knife node list $KNIFE > /dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -ge "$CHEF_ZERO_WAIT_SECONDS" ] && { cat /tmp/chef-zero.log; exit 1; }
  sleep 1
done
python3 "$INV/chef/openmap_chef_export.py" --out /tmp/chef > "$OUT/chef-export.txt"
# shellcheck disable=SC2086
knife role from file /tmp/chef/roles/*.json $KNIFE > "$OUT/chef-import.txt" 2>&1
# shellcheck disable=SC2086
knife node from file /tmp/chef/nodes/*.json $KNIFE >> "$OUT/chef-import.txt" 2>&1
# shellcheck disable=SC2086
knife node list -F json $KNIFE > "$OUT/chef-nodes.json"
# shellcheck disable=SC2086
knife node show "$CERTNAME" -l -F json $KNIFE > "$OUT/chef-node.json"
# shellcheck disable=SC2086
knife search node "run_list:role\[$SITE_ROLE\]" -i -F json $KNIFE > "$OUT/chef-search.json"
# shellcheck disable=SC2086
knife search node "openmap_site:$SITE_CODE" -i -F json $KNIFE > "$OUT/chef-search-site.json"
# The README's merge for a node Chef already runs: a run list of its own survives, the openmap facts are replaced.
# shellcheck disable=SC2086
knife exec -E "n = nodes.find('name:$CERTNAME').first; n.run_list.reset!('recipe[own::base]'); n.normal['openmap'] = {}; n.save" $KNIFE > /dev/null
# shellcheck disable=SC2086
knife exec -E "n = nodes.find('name:$CERTNAME').first; n.normal['openmap'] = JSON.parse(File.read('/tmp/chef/nodes/$CERTNAME.json'))['normal']['openmap']; n.save" $KNIFE > /dev/null
# shellcheck disable=SC2086
knife node show "$CERTNAME" -l -F json $KNIFE > "$OUT/chef-merged.json"
echo "inventory check: done"
