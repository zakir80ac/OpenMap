// REQ-DISC-020 — port_scan collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/portscan"
)

func main() {
	collector.Main(portscan.Collector{})
}
