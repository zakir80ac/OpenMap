// T-401 REQ-QA-005 REQ-DISC-001 — the real snmp collector, over SNMPv3 authPriv (engine discovery, every USM
// protocol pair the collector supports), reconstructs every estate network device: the device, its ports
// with their facts, VLANs and access membership, addresses, ARP-learned peers and LLDP neighbours.
package snmpnet

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedNetworkDevices(t *testing.T) {
	e := simtest.Estate(t)
	pairs := map[secPair]int{}
	oses := map[string]int{}
	for _, c := range devices(e) {
		pairs[load(e, c).sec]++
		oses[c.Str("osName")]++
	}
	for _, p := range secPairs {
		if pairs[p] == 0 {
			t.Fatalf("USM pair %s/%s runs against no device: %v", p.auth, p.priv, pairs)
		}
	}
	for os := range oses {
		if _, ok := flavours[os]; !ok {
			t.Errorf("estate OS %q has no vendor agent format", os)
		}
	}
	simtest.Run(t, Vendor{})
}
