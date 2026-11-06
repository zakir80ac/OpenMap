// T-317 REQ-DISC-001 — recorded SNMPv1 fixture: `snmpwalk -v1 -On -m ”` (GETNEXT, no GETBULK in v1)
// from a real Net-SNMP 5.9.4 agent in the container lab, loaded with the T-301 loader and run through
// Parse and Emit. SNMPv1 cannot carry Counter64, so the agent skips the ifXTable HC counters; the
// inventory (device, interfaces, addresses, ARP) must come out the same as over v2c.
package snmp

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	g "github.com/gosnmp/gosnmp"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const v1WalkFile = "v1.walk"

// ifXTable entry; its HC counter columns (ifHCInOctets .6 … ifHCOutBroadcastPkts .13) are Counter64.
const (
	ifXTableEntry = ".1.3.6.1.2.1.31.1.1.1."
	firstHCColumn = 6
	lastHCColumn  = 13
)

func TestREQDISC001_T317_RecordedV1Fixtures(t *testing.T) {
	entries, err := os.ReadDir(snmpFixtureRoot)
	if err != nil {
		t.Fatalf("fixture root: %v", err)
	}
	walks := 0
	for _, e := range entries {
		path := filepath.Join(snmpFixtureRoot, e.Name(), v1WalkFile)
		if !e.IsDir() {
			continue
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		walks++
		exp, ok := snmpExpectations[e.Name()]
		if !ok {
			t.Errorf("fixture %s has no expectation row", e.Name())
			continue
		}
		t.Run(e.Name(), func(t *testing.T) {
			if bytes.Contains(raw, []byte("Counter64")) {
				t.Fatal("an SNMPv1 walk cannot carry Counter64 varbinds")
			}
			ifx := 0
			for _, line := range strings.Split(string(raw), "\n") {
				if strings.HasPrefix(line, ifXTableEntry) {
					ifx++
					col, _ := strconv.Atoi(strings.SplitN(strings.TrimPrefix(line, ifXTableEntry), ".", 2)[0])
					if col >= firstHCColumn && col <= lastHCColumn {
						t.Errorf("HC counter column %d present over v1: %s", col, line)
					}
				}
			}
			if ifx == 0 {
				t.Fatal("ifXTable missing from the v1 walk")
			}

			target := contract.Target{Kind: "host", Value: exp.sysName}
			w := loadWalk(t, filepath.Join(snmpFixtureRoot, e.Name(), v1WalkFile), target)
			d := Parse(w)
			if d.Manufacturer == "" {
				d.Manufacturer = vendorFromSysObjectID(d.SysObjectID)
			}
			assertSnmpDevice(t, d, exp)
			obs := Emit(d, target, []byte("walk"), w.At)
			assertSnmpObservation(t, obs, exp)
		})
	}
	if walks == 0 {
		t.Fatal("no recorded SNMPv1 walk found")
	}
}

func TestREQDISC001_T317_V1Client(t *testing.T) {
	cred := &contract.Credential{Type: "snmp_v2c", Fields: map[string]string{credCommunity: "lab"}}
	target := contract.Target{Kind: "host", Value: "127.0.0.1"}
	for opt, want := range map[string]g.SnmpVersion{"1": g.Version1, "v1": g.Version1, "2c": g.Version2c, "": g.Version2c} {
		options := map[string]any{}
		if opt != "" {
			options[optionVersion] = opt
		}
		c, err := clientFor(target, cred, options)
		if err != nil {
			t.Fatalf("snmpVersion %q: %v", opt, err)
		}
		if c.Version != want {
			t.Errorf("snmpVersion %q: version %v want %v", opt, c.Version, want)
		}
	}
}
