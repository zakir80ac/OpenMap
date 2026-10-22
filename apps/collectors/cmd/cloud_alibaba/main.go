// REQ-DISC-010 — cloud_alibaba (ECS, VPC, RDS, SLB over RPC signatures; ACK over ROA signatures) collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/alibaba"
	"github.com/openmap/openmap/apps/collectors/internal/collector"
)

func main() {
	collector.Main(alibaba.Collector{})
}
