//go:build !windows

// REQ-DISC-031 — on Linux the Node is supervised by systemd and runs in the foreground.
package main

import (
	"log/slog"

	"github.com/openmap/openmap/apps/node/internal/config"
)

func runAsServiceIfNeeded(_ config.Config, _ *slog.Logger) (bool, error) {
	return false, nil
}
