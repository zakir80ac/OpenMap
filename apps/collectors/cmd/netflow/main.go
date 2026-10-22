// REQ-DISC-019 — netflow (NetFlow v5/v9, IPFIX, sFlow) collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/netflow"
)

func main() {
	collector.Main(netflow.Collector{})
}
