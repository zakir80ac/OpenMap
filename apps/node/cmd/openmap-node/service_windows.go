//go:build windows

// REQ-DISC-031 — Windows service hosting for the Discovery Node: under the Service Control Manager the Node reports
// its state and runs `run` until Stop or Shutdown. Installed with deploy/install/install-node.ps1 (New-Service).
package main

import (
	"context"
	"log/slog"

	"golang.org/x/sys/windows/svc"

	"github.com/openmap/openmap/apps/node/internal/config"
)

const serviceName = "OpenMapNode"

type nodeService struct {
	cfg config.Config
	log *slog.Logger
}

func (s *nodeService) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- run(ctx, s.cfg, s.log) }()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case err := <-done:
			cancel()
			if err != nil {
				s.log.Error("node stopped with error", "err", err)
				return true, 1
			}
			return false, 0
		case req := <-requests:
			switch req.Cmd {
			case svc.Interrogate:
				status <- req.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				<-done
				return false, 0
			default:
			}
		}
	}
}

// runAsServiceIfNeeded hosts the Node under the SCM when that is how it was started; false means run normally.
func runAsServiceIfNeeded(cfg config.Config, log *slog.Logger) (bool, error) {
	isService, err := svc.IsWindowsService()
	if err != nil || !isService {
		return false, err
	}
	return true, svc.Run(serviceName, &nodeService{cfg: cfg, log: log})
}
