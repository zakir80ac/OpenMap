// REQ-DISC-014 — storage (Pure Storage FlashArray) collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/purestorage"
)

func main() {
	collector.Main(purestorage.Collector{})
}
