// REQ-DISC-015 — fc_fabric collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/fcfabric"
)

func main() {
	collector.Main(fcfabric.Collector{})
}
