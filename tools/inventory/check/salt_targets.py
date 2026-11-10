#!/usr/bin/env python3
# REQ-INT-011 (ADR-072) — resolves salt-ssh targets the way salt-ssh does, through Salt's own roster loader: the flat
# roster over a roster file (its YAML rendered by Salt's renderer pipeline) and OpenMap's roster module live from the
# API. Prints {"flat": {...}, "openmap": {...}}: each minion id with the connection settings Salt read.
#   salt_targets.py <roster-file> <extension-modules-dir>
import json
import sys
import tempfile

import salt.config
import salt.roster


def resolve(roster_name, extra):
    with tempfile.TemporaryDirectory() as root:
        opts = salt.config.master_config(None)
        opts.update({"root_dir": root, "cachedir": root, "pki_dir": root, "sock_dir": root, "log_file": root + "/log"})
        opts.update(extra)
        return salt.roster.Roster(opts, roster_name).targets("*", "glob")


def main():
    roster_file, extension_modules = sys.argv[1], sys.argv[2]
    flat = resolve("flat", {"roster_file": roster_file})
    live = resolve("openmap", {"extension_modules": extension_modules})
    json.dump({"flat": flat, "openmap": live}, sys.stdout, default=str)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
