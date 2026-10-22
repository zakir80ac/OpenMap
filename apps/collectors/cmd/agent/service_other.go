//go:build !windows

// REQ-DISC-004 — on Linux and macOS the agent is supervised by systemd or launchd and simply runs in the foreground.
package main

import "log/slog"

func runAsServiceIfNeeded(_ config, _ *slog.Logger) (bool, error) {
	return false, nil
}
