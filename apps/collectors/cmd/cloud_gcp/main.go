// REQ-DISC-010 — cloud_gcp (Compute Engine, Cloud SQL, GKE over REST with a service-account JWT) collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/gcp"
)

func main() {
	collector.Main(gcp.Collector{})
}
