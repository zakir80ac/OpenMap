// REQ-DISC-013 — cisco_ucs (UCS Manager XML API) collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/ucs"
)

func main() {
	collector.Main(ucs.Collector{})
}
