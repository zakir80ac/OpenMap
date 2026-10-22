// REQ-DISC-010 — cloud_aws collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/aws"
	"github.com/openmap/openmap/apps/collectors/internal/collector"
)

func main() {
	collector.Main(aws.Collector{})
}
