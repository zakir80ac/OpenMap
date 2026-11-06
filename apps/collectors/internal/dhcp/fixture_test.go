// T-310 REQ-DISC-022 — recorded vendor fixtures: the stdout of the collector's own IscScript and
// KeaScript run inside real ISC dhcpd 4.4.3-P1 and Kea 2.2.0 servers after real busybox udhcpc clients
// took leases (packages/testing/fixtures/vendor/dhcp). The test splits the transcript exactly as
// Collect does and runs the real parsers and Emit.
package dhcp

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/sshexec"
)

const fxDHCPFamilyDir = "../../../../packages/testing/fixtures/vendor/dhcp"

type fxLeaseExpect struct {
	mac, hostname string
}

type fxDHCPExpect struct {
	mode        string
	scopes      map[string][2]string // cidr -> range start, end
	poolSize    map[string]int
	router      map[string]string
	dns         map[string][]string
	leaseTTL    map[string]string
	leases      map[string]fxLeaseExpect // address -> mac, hostname
	activeLabCI int                      // activeLeases on the 10.250.70.0/24 scope
}

var fxDHCPFixtures = map[string]fxDHCPExpect{
	"isc-dhcpd-4.4.3-P1": {
		mode:     modeISC,
		scopes:   map[string][2]string{"10.250.70.0/24": {"10.250.70.100", "10.250.70.150"}, "10.250.71.0/24": {"10.250.71.50", "10.250.71.99"}},
		poolSize: map[string]int{"10.250.70.0/24": 51, "10.250.71.0/24": 50},
		router:   map[string]string{"10.250.70.0/24": "10.250.70.1", "10.250.71.0/24": "10.250.71.1"},
		dns:      map[string][]string{"10.250.70.0/24": {"10.250.70.53", "10.250.70.54"}, "10.250.71.0/24": {"10.250.70.53"}},
		leaseTTL: map[string]string{"10.250.70.0/24": "600", "10.250.71.0/24": "3600"},
		leases: map[string]fxLeaseExpect{
			"10.250.70.100": {"16:1c:b6:f2:44:12", "web-01"},
			"10.250.70.101": {"b2:af:94:5c:b8:b3", "app-02"},
			"10.250.70.102": {"c6:06:e5:ab:23:0a", "printer-03"},
		},
		activeLabCI: 3,
	},
	"isc-kea-dhcp4-2.2.0": {
		mode:     modeKea,
		scopes:   map[string][2]string{"10.250.70.0/24": {"10.250.70.160", "10.250.70.199"}, "10.250.72.0/24": {"10.250.72.20", "10.250.72.80"}},
		poolSize: map[string]int{"10.250.70.0/24": 40, "10.250.72.0/24": 61},
		router:   map[string]string{"10.250.70.0/24": "10.250.70.1", "10.250.72.0/24": "10.250.72.1"},
		dns:      map[string][]string{"10.250.70.0/24": {"10.250.70.53", "10.250.70.54"}},
		leaseTTL: map[string]string{"10.250.70.0/24": "900", "10.250.72.0/24": "900"},
		leases: map[string]fxLeaseExpect{
			"10.250.70.160": {"f2:d6:45:3f:31:e2", "nas-04"},
			"10.250.70.161": {"3e:4f:7a:5d:aa:c5", "cam-05"},
			"10.250.70.162": {"76:39:dc:0d:17:ec", "kiosk-06"},
			"10.250.70.163": {"c2:ad:d1:34:38:ca", "guest-07"},
		},
		activeLabCI: 4,
	},
}

func TestREQDISC022_T310_RecordedVendorFixtures(t *testing.T) {
	dirs, err := os.ReadDir(fxDHCPFamilyDir)
	if err != nil {
		t.Fatalf("fixture family dir: %v", err)
	}
	seen := 0
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		want, ok := fxDHCPFixtures[d.Name()]
		if !ok {
			t.Errorf("fixture %s has no expectation row", d.Name())
			continue
		}
		seen++
		dir := filepath.Join(fxDHCPFamilyDir, d.Name())
		t.Run(d.Name(), func(t *testing.T) {
			if _, err := os.Stat(filepath.Join(dir, "manifest.json")); err != nil {
				t.Fatalf("manifest: %v", err)
			}
			raw, err := os.ReadFile(filepath.Join(dir, "transcript.txt"))
			if err != nil {
				t.Fatal(err)
			}
			sections, order := sshexec.Split(string(raw))
			if len(order) != 2 || sections["config"] == "" || sections["leases"] == "" {
				t.Fatalf("transcript sections %v", order)
			}
			var scopes []Scope
			var leases []Lease
			if want.mode == modeISC {
				scopes = ParseIscConfig(sections["config"])
				leases = ParseIscLeases(sections["leases"], scopes)
			} else {
				scopes = ParseKeaConfig(sections["config"])
				leases = ParseKeaLeases(sections["leases"], scopes)
			}
			if len(scopes) != len(want.scopes) {
				t.Fatalf("scopes = %+v, want %d", scopes, len(want.scopes))
			}
			if len(leases) != len(want.leases) {
				t.Fatalf("leases = %+v, want %d", leases, len(want.leases))
			}
			const server = "10.250.70.67"
			obs := Emit(server, scopes, leases, raw, time.Now())
			scopeCIs := map[string]contract.ObservedCi{}
			leaseCIs := map[string]contract.ObservedCi{}
			ipCIs := map[string]contract.ObservedCi{}
			for _, c := range obs.Cis {
				switch c.Type {
				case typeScope:
					scopeCIs[c.Identity["cidr"]] = c
				case typeLease:
					leaseCIs[c.Identity["address"]] = c
				case typeIP:
					ipCIs[c.Identity["address"]] = c
				}
			}
			for cidr, rng := range want.scopes {
				c, ok := scopeCIs[cidr]
				if !ok {
					t.Errorf("no dhcp_scope %s", cidr)
					continue
				}
				a := c.Attributes
				if a["rangeStart"] != rng[0] || a["rangeEnd"] != rng[1] || a["poolSize"] != want.poolSize[cidr] || a["router"] != want.router[cidr] || a["leaseTtl"] != want.leaseTTL[cidr] {
					t.Errorf("scope %s attributes %v", cidr, a)
				}
				gotDNS, _ := a["dnsServers"].([]string)
				if len(gotDNS) != len(want.dns[cidr]) {
					t.Errorf("scope %s dns %v, want %v", cidr, gotDNS, want.dns[cidr])
				}
				for i := range gotDNS {
					if i < len(want.dns[cidr]) && gotDNS[i] != want.dns[cidr][i] {
						t.Errorf("scope %s dns %v, want %v", cidr, gotDNS, want.dns[cidr])
					}
				}
			}
			if got := scopeCIs["10.250.70.0/24"].Attributes["activeLeases"]; got != want.activeLabCI {
				t.Errorf("activeLeases = %v, want %d", got, want.activeLabCI)
			}
			for addr, l := range want.leases {
				c, ok := leaseCIs[addr]
				if !ok {
					t.Errorf("no dhcp_lease %s", addr)
					continue
				}
				if c.Attributes["mac"] != l.mac || c.Attributes["hostname"] != l.hostname || c.Attributes["state"] != "active" || c.Identity["scopeRef"] != "10.250.70.0/24" {
					t.Errorf("lease %s attributes %v", addr, c.Attributes)
				}
				if ip, ok := ipCIs[addr]; !ok || ip.Attributes["mac"] != l.mac || ip.Attributes["allocation"] != "dynamic" {
					t.Errorf("ip_address %s = %v", addr, ip.Attributes)
				}
			}
			leasedTo, contains, inSubnet := map[string]bool{}, 0, 0
			for _, r := range obs.Relationships {
				switch r.Type {
				case relLeasedTo:
					if r.To.Type != typeHost || r.To.Identity["fqdn"] != want.leases[r.From.Identity["address"]].hostname {
						t.Errorf("leased_to %v -> %v", r.From.Identity, r.To.Identity)
					}
					leasedTo[r.To.Identity["primaryMac"]] = true
				case relContains:
					contains++
				case relInSubnet:
					inSubnet++
				}
			}
			for _, l := range want.leases {
				if !leasedTo[l.mac] {
					t.Errorf("no leased_to for %s", l.mac)
				}
			}
			if contains != len(want.leases) || inSubnet != len(want.scopes) {
				t.Errorf("contains=%d in_subnet=%d", contains, inSubnet)
			}
		})
	}
	if seen == 0 {
		t.Fatal("no recorded DHCP fixtures found")
	}
}
