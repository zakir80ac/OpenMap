// REQ-DISC-001 — snmp collector binary. Reads the invocation on stdin, writes a Result on stdout.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/snmp"
)

func main() {
	collector.Main(snmp.Collector{})
}
