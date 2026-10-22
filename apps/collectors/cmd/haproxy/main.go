// REQ-DISC-018 — haproxy (statistics endpoint) collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/haproxy"
)

func main() {
	collector.Main(haproxy.Collector{})
}
