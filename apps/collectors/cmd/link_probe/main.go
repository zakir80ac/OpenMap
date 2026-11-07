// REQ-BSM-007 (ADR-025) — link_probe collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/linkprobe"
)

func main() {
	collector.Main(linkprobe.Collector{})
}
