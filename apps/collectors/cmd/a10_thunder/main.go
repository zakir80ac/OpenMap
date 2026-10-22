// REQ-DISC-018 — a10_thunder (aXAPI v3) collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/a10"
	"github.com/openmap/openmap/apps/collectors/internal/collector"
)

func main() {
	collector.Main(a10.Collector{})
}
