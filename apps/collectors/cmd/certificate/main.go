// REQ-DISC-025 — certificate collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/certificate"
	"github.com/openmap/openmap/apps/collectors/internal/collector"
)

func main() {
	collector.Main(certificate.Collector{})
}
