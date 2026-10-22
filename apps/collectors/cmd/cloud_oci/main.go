// REQ-DISC-010 — cloud_oci (Identity, Core, Database, Container Engine, Load Balancer over signed REST) collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/oci"
)

func main() {
	collector.Main(oci.Collector{})
}
