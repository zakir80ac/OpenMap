// REQ-INT-017 — backup collector binary: Veeam Backup & Replication, Commvault and Rubrik CDM (ADR-075).
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/backup"
	"github.com/openmap/openmap/apps/collectors/internal/collector"
)

func main() {
	collector.Main(backup.Collector{})
}
