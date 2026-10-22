// REQ-DISC-010 — cloud_azure collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/azure"
	"github.com/openmap/openmap/apps/collectors/internal/collector"
)

func main() {
	collector.Main(azure.Collector{})
}
