#!/usr/bin/env sh
# REQ-INT-002 REQ-INT-008 — loads the offline bundle on the air-gapped host and starts the stack with
# pull_policy never. Run from the extracted bundle directory:
#   ./load-bundle.sh [version]
set -eu
version="${1:-dev}"
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

echo "verifying checksums"
# BusyBox (Alpine) and GNU coreutils agree on -c; --quiet/--status do not exist on BusyBox.
sha256sum -c SHA256SUMS >/dev/null

echo "loading images"
gunzip -c "openmap-images-${version}.tar.gz" | docker load

if [ ! -f .env ]; then
  cp .env.example .env
  echo "created .env from .env.example: edit the secrets before exposing the stack"
fi

echo "starting OpenMap (air-gapped profile)"
OPENMAP_VERSION="$version" docker compose -f docker-compose.yml -f docker-compose.apps.yml -f docker-compose.airgap.yml up -d
docker compose ps
