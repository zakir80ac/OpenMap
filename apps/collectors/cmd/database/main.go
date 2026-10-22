// REQ-DISC-024 — database collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/database"
)

func main() {
	collector.Main(database.Collector{})
}
