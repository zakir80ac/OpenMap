// REQ-DISC-017 — object_storage (S3-compatible) collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/objectstore"
)

func main() {
	collector.Main(objectstore.Collector{})
}
