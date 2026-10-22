// REQ-DISC-003 — ssh_agentless collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/sshlinux"
)

func main() {
	collector.Main(sshlinux.Collector{})
}
