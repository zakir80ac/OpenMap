// REQ-DISC-022 — dhcp collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/dhcp"
)

func main() {
	collector.Main(dhcp.Collector{})
}
