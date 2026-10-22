// REQ-DISC-018 — citrix_adc (NetScaler NITRO REST) collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/citrixadc"
	"github.com/openmap/openmap/apps/collectors/internal/collector"
)

func main() {
	collector.Main(citrixadc.Collector{})
}
