// REQ-DISC-009 — oracle_vm (oVirt / OLVM / RHV) collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/ovirt"
)

func main() {
	collector.Main(ovirt.Collector{})
}
