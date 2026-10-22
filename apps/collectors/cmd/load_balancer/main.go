// REQ-DISC-018 — load_balancer (F5 BIG-IP) collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/f5"
)

func main() {
	collector.Main(f5.Collector{})
}
