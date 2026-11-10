#!/bin/sh
# REQ-INT-018 — provisions the appliance image (run by Packer inside the VM being built, on a connected build
# machine): Docker Engine and its compose plugin from Docker's apt repository, the OpenMap air-gap bundle
# (deploy/airgap-bundle/build-bundle.sh output) verified and its images loaded into the VM's Docker, and the systemd
# units that generate the appliance's secrets on its first boot and start the air-gapped stack. Nothing starts here:
# the image ships with no secrets and no data; each VM made from it gets its own on first boot.
#   OPENMAP_BUNDLE_DIR  where Packer copied the bundle (default /tmp/openmap-bundle)
#   OPENMAP_VERSION     the bundle's version (its image tag)
set -eu
BUNDLE="${OPENMAP_BUNDLE_DIR:-/tmp/openmap-bundle}"
VERSION="${OPENMAP_VERSION:?OPENMAP_VERSION is required}"
ROOT="${OPENMAP_ROOT:-/opt/openmap}"
export DEBIAN_FRONTEND=noninteractive

log() { printf '{"msg":"%s"}\n' "$1"; }

log "installing Docker Engine"
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
. /etc/os-release
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' "$(dpkg --print-architecture)" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list
apt-get update -q
apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable docker

log "installing the bundle"
(cd "$BUNDLE" && sha256sum -c SHA256SUMS > /dev/null)
mkdir -p "$ROOT"
cp -R "$BUNDLE"/. "$ROOT"/
gunzip -c "$ROOT/openmap-images-$VERSION.tar.gz" | docker load
rm "$ROOT/openmap-images-$VERSION.tar.gz"
printf 'OPENMAP_VERSION=%s\n' "$VERSION" > "$ROOT/appliance.env"

log "installing the units"
install -m 0755 "$BUNDLE/appliance/openmap-firstboot.sh" "$ROOT/openmap-firstboot.sh"
install -m 0644 "$BUNDLE/appliance/openmap-firstboot.service" /etc/systemd/system/openmap-firstboot.service
install -m 0644 "$BUNDLE/appliance/openmap.service" /etc/systemd/system/openmap.service
systemctl daemon-reload
systemctl enable openmap-firstboot.service openmap.service

log "clearing the build machine's identity"
# The build user is locked and expired; the operator's own access comes from the hypervisor's cloud-init or console.
if [ -n "${OPENMAP_BUILD_USER:-}" ]; then
  usermod -L -e 1 "$OPENMAP_BUILD_USER" || true
  rm -f "/etc/sudoers.d/90-cloud-init-users"
fi
rm -f /etc/ssh/ssh_host_* /var/lib/openmap/firstboot.done
truncate -s 0 /etc/machine-id
cloud-init clean --logs || true
log "appliance image ready"
