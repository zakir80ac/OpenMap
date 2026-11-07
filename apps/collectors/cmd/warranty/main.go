// REQ-CMDB-024 — warranty (Dell TechDirect, Lenovo, Cisco SN2INFO and EoX lookups by serial) collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/warranty"
)

func main() {
	collector.Main(warranty.Collector{})
}
