// REQ-DISC-008 — nutanix_ahv collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/nutanix"
)

func main() {
	collector.Main(nutanix.Collector{})
}
