#!/usr/bin/env sh
# REQ-INT-002 REQ-INT-008 — builds the offline bundle on a connected machine: every image the compose
# profiles reference (infrastructure and OpenMap services), saved as one tar with a checksum manifest,
# plus the compose files and this directory's load script. Usage:
#   deploy/airgap-bundle/build-bundle.sh [version] [output-dir]
set -eu
version="${1:-dev}"
out="${2:-$(pwd)/openmap-bundle-${version}}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
compose="$repo/deploy/compose"
mkdir -p "$out"

echo "building OpenMap images ${version}"
for app in api scheduler reconciler bsm-engine; do
  docker build -f "$repo/deploy/docker/node-service.Dockerfile" --build-arg APP="$app" -t "openmap/${app}:${version}" "$repo"
done
docker build -f "$repo/deploy/docker/console.Dockerfile" -t "openmap/console:${version}" "$repo"
docker build -f "$repo/deploy/docker/node.Dockerfile" -t "openmap/node:${version}" "$repo"
# REQ-INT-019: the backup service (PostgreSQL 17 client tools and the backup script).
docker build -f "$repo/deploy/docker/backup.Dockerfile" -t "openmap/backup:${version}" "$repo"

echo "collecting infrastructure images from the compose files"
infra="$(OPENMAP_VERSION="$version" docker compose -f "$compose/docker-compose.yml" -f "$compose/docker-compose.apps.yml" --profile cpu --profile node config --images | sort -u)"
images="$infra"
for app in api scheduler reconciler bsm-engine console node backup; do
  images="$images
openmap/${app}:${version}"
done
images="$(printf '%s\n' "$images" | sort -u)"
printf '%s\n' "$images" > "$out/images.txt"

echo "pulling infrastructure images"
printf '%s\n' "$infra" | grep -v '^openmap/' | while read -r img; do
  [ -n "$img" ] && docker pull "$img"
done

echo "saving images"
# shellcheck disable=SC2086
docker save $(printf '%s ' $images) | gzip -1 > "$out/openmap-images-${version}.tar.gz"

cp "$compose/docker-compose.yml" "$compose/docker-compose.apps.yml" "$compose/docker-compose.airgap.yml" "$compose/.env.example" "$out/"
cp -R "$compose/keycloak" "$compose/postgres" "$compose/superset" "$compose/otel" "$compose/prometheus" "$compose/clickhouse" "$compose/openbao" "$out/"
cp "$here/load-bundle.sh" "$out/"
# The CPU LLM profile needs its weights offline: ship the GGUF named in .env (or .env.example) when it is present.
models_dir="$compose/models"
gguf="$( { [ -f "$compose/.env" ] && grep -E '^LLM_GGUF=' "$compose/.env"; } || grep -E '^LLM_GGUF=' "$compose/.env.example" || true)"
gguf="${gguf#LLM_GGUF=}"
if [ -n "$gguf" ] && [ -f "$models_dir/$gguf" ]; then
  mkdir -p "$out/models"
  cp "$models_dir/$gguf" "$out/models/"
  echo "bundled LLM weights: $gguf"
else
  echo "no LLM weights at $models_dir/$gguf: the cpu profile will need them copied into ./models on the target"
fi
cp "$repo/deploy/README.md" "$out/DEPLOY.md"

(cd "$out" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
echo "bundle ready: $out"
du -sh "$out"
