// T-034 REQ-DISC-005 — walks a vSphere Automation API served by httptest in both the 7.0 `/api`
// and the legacy `/rest` envelope styles and checks the emitted clusters, hypervisors, VMs,
// datastores and relationships. Real vCenter recordings live under packages/testing/fixtures/vendor/vmware.
package vmware

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func documents() map[string]any {
	return map[string]any{
		"/api/appliance/system/version": map[string]any{"version": "8.0.3.00400", "build": "24322831", "product": "VMware vCenter Server"},
		"/api/vcenter/cluster":          []map[string]any{{"cluster": "domain-c7", "name": "RYD-PROD-01", "drs_enabled": true, "ha_enabled": true}},
		"/api/vcenter/host?clusters=domain-c7": []map[string]any{
			{"host": "host-10", "name": "esx-ryd-01.corp.example", "connection_state": "CONNECTED", "power_state": "POWERED_ON"},
			{"host": "host-11", "name": "esx-ryd-02.corp.example", "connection_state": "CONNECTED", "power_state": "POWERED_ON"},
		},
		"/api/vcenter/host":             []map[string]any{{"host": "host-10", "name": "esx-ryd-01.corp.example"}, {"host": "host-11", "name": "esx-ryd-02.corp.example"}, {"host": "host-20", "name": "esx-standalone.corp.example", "connection_state": "CONNECTED", "power_state": "POWERED_ON"}},
		"/api/vcenter/datastore":        []map[string]any{{"datastore": "datastore-30", "name": "PURE-LUN-01", "type": "VMFS", "capacity": 10995116277760, "free_space": 4398046511104}, {"datastore": "datastore-31", "name": "NAS-ISO", "type": "NFS", "capacity": 1099511627776, "free_space": 549755813888}},
		"/api/vcenter/vm?hosts=host-10": []map[string]any{{"vm": "vm-100", "name": "pg-core-01", "power_state": "POWERED_ON", "cpu_count": 8, "memory_size_MiB": 65536}},
		"/api/vcenter/vm?hosts=host-11": []map[string]any{},
		"/api/vcenter/vm?hosts=host-20": []map[string]any{},
		"/api/vcenter/vm/vm-100": map[string]any{"guest_OS": "RHEL_9_64", "hardware": map[string]any{"version": "VMX_21"},
			"identity": map[string]any{"name": "pg-core-01", "instance_uuid": "5035A1B2-0C3D-4E5F-8A9B-0C1D2E3F4A5B", "bios_uuid": "42350000-0000-0000-0000-000000000001"},
			"nics":     map[string]any{"4000": map[string]any{"mac_address": "00:50:56:AA:BB:01", "state": "CONNECTED", "backing": map[string]any{"network": "network-40", "network_name": "VLAN-120-DB"}}},
			"disks":    map[string]any{"2000": map[string]any{"capacity": 536870912000, "backing": map[string]any{"vmdk_file": "[PURE-LUN-01] pg-core-01/pg-core-01.vmdk"}}},
			"cpu":      map[string]any{"count": 8}, "memory": map[string]any{"size_MiB": 65536}},
		"/api/vcenter/vm/vm-100/guest/identity":              map[string]any{"name": "RHEL_9_64", "family": "LINUX", "full_name": map[string]any{"default_message": "Red Hat Enterprise Linux 9 (64-bit)"}, "host_name": "pg-core-01.corp.example", "ip_address": "10.120.0.21"},
		"/api/vcenter/vm/vm-100/guest/networking/interfaces": []map[string]any{{"mac_address": "00:50:56:AA:BB:01", "ip": map[string]any{"ip_addresses": []map[string]any{{"ip_address": "10.120.0.21", "prefix_length": 24}}}}},
	}
}

const testToken = "f1e2d3c4-session-token"

func server(t *testing.T, legacy bool) *httptest.Server {
	t.Helper()
	docs := documents()
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.URL.Path
		if r.URL.RawQuery != "" {
			key += "?" + r.URL.RawQuery
		}
		if legacy {
			if strings.HasPrefix(key, "/api/") {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			if key == "/rest/com/vmware/cis/session" {
				key = "/api/session"
			} else {
				// 6.5-6.7 name list filters filter.<field>; a bare 7.0 filter name is an invalid argument.
				key = "/api" + strings.TrimPrefix(r.URL.Path, "/rest")
				if r.URL.RawQuery != "" {
					q := url.Values{}
					for k, v := range r.URL.Query() {
						field, ok := strings.CutPrefix(k, legacyFilterPrefix)
						if !ok {
							w.WriteHeader(http.StatusBadRequest)
							return
						}
						q[field] = v
					}
					key += "?" + q.Encode()
				}
			}
		}
		if key == "/api/session" {
			if r.Method == http.MethodDelete {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			u, p, ok := r.BasicAuth()
			if !ok || u != "administrator@vsphere.local" || p != "secret" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			writeDoc(w, legacy, testToken)
			return
		}
		if r.Header.Get(sessionHeader) != testToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		doc, ok := docs[key]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		writeDoc(w, legacy, doc)
	}))
}

func writeDoc(w http.ResponseWriter, legacy bool, doc any) {
	w.Header().Set("Content-Type", "application/json")
	if legacy {
		doc = map[string]any{"value": legacyMaps(doc)}
	}
	_ = json.NewEncoder(w).Encode(doc)
}

// legacyMaps renders VM NIC and disk maps the way the 6.5-6.7 /rest envelope does: [{key, value}] arrays.
func legacyMaps(doc any) any {
	m, ok := doc.(map[string]any)
	if !ok {
		return doc
	}
	out := map[string]any{}
	for k, v := range m {
		inner, isMap := v.(map[string]any)
		if (k == "nics" || k == "disks") && isMap {
			pairs := []map[string]any{}
			for key, value := range inner {
				pairs = append(pairs, map[string]any{"key": key, "value": value})
			}
			out[k] = pairs
			continue
		}
		out[k] = v
	}
	return out
}

func clientFor(t *testing.T, srv *httptest.Server, user, pass string) *Client {
	t.Helper()
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	c, err := NewClient(u.Hostname(), port, user, pass, false, "")
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func countType(cis []contract.ObservedCi, typ string) int {
	n := 0
	for _, c := range cis {
		if c.Type == typ {
			n++
		}
	}
	return n
}

func assertInventory(t *testing.T, srv *httptest.Server) {
	t.Helper()
	c := clientFor(t, srv, "administrator@vsphere.local", "secret")
	ctx := context.Background()
	if err := c.Login(ctx); err != nil {
		t.Fatal(err)
	}
	inv, err := c.Walk(ctx, 4)
	if err != nil {
		t.Fatal(err)
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "vcenter.corp.example"}, time.Now())
	if countType(obs.Cis, typeCluster) != 1 || countType(obs.Cis, typeHypervisor) != 3 || countType(obs.Cis, typeVM) != 1 || countType(obs.Cis, typeLun) != 1 || countType(obs.Cis, typeNas) != 1 || countType(obs.Cis, typeOS) != 1 || countType(obs.Cis, typeIP) != 1 {
		t.Fatalf("unexpected CI mix: %+v", obs.Cis)
	}
	var vm contract.ObservedCi
	for _, ci := range obs.Cis {
		if ci.Type == typeVM {
			vm = ci
		}
	}
	if vm.Identity["instanceUuid"] != "5035a1b2-0c3d-4e5f-8a9b-0c1d2e3f4a5b" || vm.Identity["hypervisorRef"] != "esx-ryd-01.corp.example" || vm.Identity["fqdn"] != "pg-core-01.corp.example" {
		t.Fatalf("vm identity wrong: %+v", vm.Identity)
	}
	if vm.Attributes["cpuCount"] != 8 || vm.Attributes["memoryMb"] != 65536 || vm.Attributes["diskBytes"] != int64(536870912000) {
		t.Fatalf("vm attributes wrong: %+v", vm.Attributes)
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
	}
	if rels[relMemberOf] != 2 || rels[relRunsOn] != 1 || rels[relMountedOn] != 1 || rels[relInstalledOn] != 1 || rels[relUsesIP] != 1 || rels[relHostedOn] != 3 {
		t.Fatalf("relationship mix wrong: %+v", rels)
	}
	if inv.Version.Build != "24322831" {
		t.Fatalf("version not captured: %+v", inv.Version)
	}
}

func TestWalkModernApi(t *testing.T) {
	srv := server(t, false)
	defer srv.Close()
	assertInventory(t, srv)
}

func TestWalkLegacyRestEnvelope(t *testing.T) {
	srv := server(t, true)
	defer srv.Close()
	assertInventory(t, srv)
}

func TestBadCredentialIsAuthFailed(t *testing.T) {
	srv := server(t, false)
	defer srv.Close()
	c := clientFor(t, srv, "administrator@vsphere.local", "nope")
	err := c.Login(context.Background())
	if err == nil || !strings.Contains(err.Error(), contract.ErrAuthFailed) {
		t.Fatalf("expected auth_failed, got %v", err)
	}
}

func TestDatastoreNameParsing(t *testing.T) {
	if datastoreName("[PURE-LUN-01] a/b.vmdk") != "PURE-LUN-01" || datastoreName("nope") != "" {
		t.Fatal("datastoreName parse failed")
	}
}
