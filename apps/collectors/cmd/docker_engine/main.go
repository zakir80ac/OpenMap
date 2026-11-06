// REQ-DISC-011 — docker_engine collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/docker"
)

func main() {
	collector.Main(docker.Collector{})
}
