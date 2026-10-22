#!/usr/bin/env sh
# REQ-DISC-031 REQ-DISC-004 — builds the bare-metal release for the Discovery Node and the host agent: static
# binaries for every target (openmap-node, openmap-agent, all collectors), the install scripts and units, and
# checksums, packed as one tarball per OS/arch. The same `go build` flags as deploy/docker/node.Dockerfile.
#   deploy/install/build-release.sh <version> [out dir] [os/arch ...]
#   e.g. deploy/install/build-release.sh 1.0.0 dist/release linux/amd64 windows/amd64
set -eu
version="${1:?usage: build-release.sh <version> [out dir] [os/arch ...]}"
out="${2:-dist/release}"
if [ $# -ge 2 ]; then shift 2; else shift 1; fi
targets="${*:-linux/amd64 linux/arm64 windows/amd64 darwin/arm64 darwin/amd64}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$out"
out="$(cd "$out" && pwd)"

for target in $targets; do
  os="${target%/*}"
  arch="${target#*/}"
  ext=""
  [ "$os" = "windows" ] && ext=".exe"
  name="openmap-$version-$os-$arch"
  stage="$out/$name"
  rm -rf "$stage"
  mkdir -p "$stage/bin" "$stage/collectors" "$stage/install"
  echo "building $name"
  (
    cd "$root/apps/collectors"
    for d in cmd/*/; do
      n="$(basename "$d")"
      CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags="-s -w" -o "$stage/collectors/$n$ext" "./cmd/$n"
    done
    cd ../node
    CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags="-s -w" -o "$stage/bin/openmap-node$ext" ./cmd/openmap-node
  )
  # The host agent is both a collector the Node runs and the standalone service a host installs.
  cp "$stage/collectors/agent$ext" "$stage/bin/openmap-agent$ext"
  for f in "$root"/deploy/install/*; do
    case "$(basename "$f")" in
      build-release.sh) ;;
      *) cp "$f" "$stage/install/" ;;
    esac
  done
  printf '%s\n' "$version" > "$stage/VERSION"
  (cd "$stage" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
  tar -C "$out" -czf "$stage.tar.gz" "$name"
  rm -rf "$stage"
done
(cd "$out" && find . -maxdepth 1 -name "openmap-$version-*.tar.gz" -print0 | sort -z | xargs -0 sha256sum > "SHA256SUMS-$version")
echo "release $version written to $out:"
ls -l "$out" | grep "openmap-$version"
