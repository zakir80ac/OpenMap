// REQ-DISC-023 — ldap (Active Directory / LDAP) collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/directory"
)

func main() {
	collector.Main(directory.Collector{})
}
