// REQ-DISC-021 — dns collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/dnszone"
)

func main() {
	collector.Main(dnszone.Collector{})
}
