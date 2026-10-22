// REQ-DISC-018 — nginx (Plus API and stub_status) collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/nginx"
)

func main() {
	collector.Main(nginx.Collector{})
}
