// T-402 REQ-QA-005 REQ-DISC-026 — the real snmp collector, over SNMPv1, v2c and v3, reconstructs the estate's
// APC rack PDUs (with every outlet as a power_feed and its metered watts), Schneider and Liebert UPSs and
// Liebert cooling units, with their power and environmental readings.
package snmppower

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedPowerAndCooling(t *testing.T) {
	byProto := map[protocol]int{}
	byFamily := map[string]int{}
	for _, u := range units(simtest.Estate(t)) {
		byProto[u.proto]++
		byFamily[u.family]++
	}
	if byProto[protoV1] == 0 || byProto[protoV2c] == 0 || byProto[protoV3] == 0 {
		t.Fatalf("every SNMP version must run against some unit: %v", byProto)
	}
	for _, f := range []string{"apc-pdu", "apc-ups", "liebert-ups", "liebert-crac"} {
		if byFamily[f] == 0 {
			t.Fatalf("the estate has no %s unit to simulate: %v", f, byFamily)
		}
	}
	simtest.Run(t, Vendor{})
}
