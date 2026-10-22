// REQ-CMDB-022 — saas (Microsoft 365, Google Workspace, Salesforce, ServiceNow, Workday inventories) collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/saas"
)

func main() {
	collector.Main(saas.Collector{})
}
