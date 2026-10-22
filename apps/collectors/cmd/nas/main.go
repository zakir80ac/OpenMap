// REQ-DISC-016 — nas (SMB shares over WinRM, Samba and NFS exports over SSH, NFS MOUNT protocol) collector binary.
package main

import (
	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/nas"
)

func main() {
	collector.Main(nas.Collector{})
}
