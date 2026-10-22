#!/usr/bin/env bash
# REQ-DISC-001 — builds every collector binary under apps/collectors/cmd and regenerates docs/COLLECTORS.md from
# each binary's `--manifest` output, so the reference can never drift from the code.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
out="$root/.local/collectors"
mkdir -p "$out"
cd "$root/apps/collectors"
ext=""
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ext=".exe";; esac
rows=()
for d in cmd/*/; do
  n="$(basename "$d")"
  go build -o "$out/$n$ext" "./cmd/$n"
  rows+=("$("$out/$n$ext" --manifest)")
done
python - "$root/docs/COLLECTORS.md" "${rows[@]}" <<'PY'
import json, sys
path, *rows = sys.argv[1:]
manifests = sorted((json.loads(r) for r in rows), key=lambda m: m["id"])
lines = ["# Collector families", "",
  "Generated from each collector binary's `--manifest` (`apps/collectors/cmd/<family>`, via `apps/collectors/scripts/gen-docs.sh`). Credentials are OpenBao references resolved by the Node; collectors never see the vault. Every family emits the CI types listed and records raw evidence by SHA-256 digest.", "",
  "| Collector | Family | Protocols | Credential types | Target kinds | Emits |", "| --- | --- | --- | --- | --- | --- |"]
for m in manifests:
    lines.append("| `%s` | %s | %s | %s | %s | %s |" % (m["id"], m["family"], ", ".join(m["protocols"]), ", ".join(m["credentialTypes"]), ", ".join(m["targetKinds"]), ", ".join(m["emits"])))
versions = sorted({m["contractVersion"] for m in manifests})
lines += ["", "%d families, contract version %s. Source of truth: the manifests; regenerate this file after adding a family." % (len(manifests), ", ".join(versions)), ""]
open(path, "w", encoding="utf-8", newline="\n").write("\n".join(lines))
print("wrote", path, len(manifests), "families")
PY
