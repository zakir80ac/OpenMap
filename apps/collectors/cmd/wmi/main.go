// REQ-DISC-002 — wmi (WinRM) collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/windows"
)

func main() {
	collector.Main(windows.Collector{})
}
