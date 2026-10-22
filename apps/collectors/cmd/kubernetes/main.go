// REQ-DISC-011 — kubernetes collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/kubernetes"
)

func main() {
	collector.Main(kubernetes.Collector{})
}
