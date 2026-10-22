// REQ-DISC-005 — vmware collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/vmware"
)

func main() {
	collector.Main(vmware.Collector{})
}
