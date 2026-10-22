// REQ-DISC-013 — hpe_oneview collector binary (enclosures, blades, iLOs, interconnects).
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/oneview"
)

func main() {
	collector.Main(oneview.Collector{})
}
