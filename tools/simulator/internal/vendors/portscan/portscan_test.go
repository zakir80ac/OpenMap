// T-411 REQ-QA-005 REQ-DISC-020 — the real port_scan collector scans simulated estate devices and service hosts
// (SSH greetings, HTTP and HTTPS with the estate's web-server banners behind self-signed device certificates,
// RTSP, SIP and silent services, all on ephemeral ports) and emits the scanned device, its address and one
// listening_service per open port with the service a banner-based classifier can name.
package portscan

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedServiceFingerprint(t *testing.T) {
	simtest.Run(t, Vendor{})
}
