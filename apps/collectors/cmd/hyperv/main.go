// REQ-DISC-006 — hyperv collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/hyperv"
)

func main() {
	collector.Main(hyperv.Collector{})
}
