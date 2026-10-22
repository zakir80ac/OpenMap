// REQ-DISC-007 — kvm_libvirt collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/libvirt"
)

func main() {
	collector.Main(libvirt.Collector{})
}
