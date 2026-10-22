// REQ-DISC-014 — storage (NetApp ONTAP) collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/ontap"
)

func main() {
	collector.Main(ontap.Collector{})
}
