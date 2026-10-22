// REQ-DISC-012 — ipmi_redfish collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/redfish"
)

func main() {
	collector.Main(redfish.Collector{})
}
